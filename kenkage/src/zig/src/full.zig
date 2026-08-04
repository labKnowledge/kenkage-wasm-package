// kenkage-full: Complete engine with DOM + QuickJS + Fetch interop
// Target: wasm32-wasi (needed for C/QuickJS libc support)
//
// This file imports core DOM functionality and adds:
//   1. QuickJS JavaScript execution
//   2. Fetch interop with the host browser

const std = @import("std");

// ============================================================
//  EXTERNAL HOST FUNCTIONS (provided by JS at load time)
// ============================================================

extern fn hostLog(ptr: [*]const u8, len: u32) void;

// Fetch: WASM calls this to request the host to fetch a URL
// Returns a fetch request ID for correlation
extern fn hostFetch(url_ptr: [*]const u8, url_len: u32, method_ptr: [*]const u8, method_len: u32) u32;

// ============================================================
//  GLOBAL STATE
// ============================================================

// Arena for the DOM. Larger than core.zig's since script-driven DOM
// mutation (createElement/appendChild/innerHTML) during page load can
// allocate substantially more than a single static parse ever would.
var arena_memory: [16 * 1024 * 1024]u8 = undefined;
var arena_buf: std.mem.Allocator = undefined;
var fixed_alloc: std.heap.FixedBufferAllocator = undefined;

// 256KB result buffer (aligned for u32 access)
var result_buf: [256 * 1024]u8 align(4) = undefined;
var result_len: u32 = 0;

// 128KB buffer for writing input data (HTML, JS code, URLs)
var input_buf: [128 * 1024]u8 = undefined;

var current_doc: ?*Document = null;

// Fetch state
var fetch_status_code: u32 = 0;
var fetch_body_len: u32 = 0;
var fetch_pending: bool = false;

// ============================================================
//  DOM TYPES
// ============================================================

const NodeType = enum(u8) {
    element = 1,
    text = 3,
    comment = 8,
    document = 9,
    document_fragment = 11,
};

const Attr = struct {
    name: []const u8,
    value: []const u8,
};

const Node = struct {
    id: u32,
    node_type: NodeType,
    tag: []const u8,
    text: []u8,
    attrs: []Attr,
    children: []*Node,
    parent: ?*Node = null,
};

// Max nodes addressable by id in a single document — generous headroom for
// any real page; ids beyond this just aren't registered (graceful, not a crash).
const MAX_NODES = 131072;

const Document = struct {
    root: ?*Node = null,
    head: ?*Node = null,
    body: ?*Node = null,
    title: []const u8 = "",
    node_count: u32 = 0,
    next_id: u32 = 1,
    // id -> node, populated by makeNode. Needed because DOM mutation can
    // create nodes that aren't (yet, or ever) reachable by walking the tree
    // from root — e.g. a freshly created, still-detached element.
    node_table: [MAX_NODES]?*Node = [_]?*Node{null} ** MAX_NODES,
};

// ============================================================
//  QUICKJS C FFI
// ============================================================

extern fn qjs_init() c_int;
extern fn qjs_destroy() void;
extern fn qjs_eval(code: [*]const u8, code_len: c_int) c_int;
extern fn qjs_get_result() [*]const u8;
extern fn qjs_get_result_len() c_int;
extern fn qjs_get_error() [*]const u8;
extern fn qjs_get_error_len() c_int;
extern fn qjs_last_result_type() c_int;
extern fn qjs_run_pending_jobs() c_int;
extern fn qjs_resolve_fetch(id: u32, status: u32, body: [*]const u8, body_len: u32) c_int;
extern fn qjs_reject_fetch(id: u32, msg: [*]const u8, msg_len: u32) c_int;

// ============================================================
//  HELPERS
// ============================================================

fn isVoidTag(tag: []const u8) bool {
    const tags = [_][]const u8{
        "area",  "base",  "br",   "col",   "embed", "hr",
        "img",   "input", "link", "meta",  "param",
        "source","track", "wbr",
    };
    for (tags) |vt| {
        if (eqI(tag, vt)) return true;
    }
    return false;
}

fn isSkipTag(tag: []const u8) bool {
    return eqI(tag, "script") or eqI(tag, "style");
}

fn dup(allocator: std.mem.Allocator, s: []const u8) []const u8 {
    return allocator.dupe(u8, s) catch s;
}

fn dupMut(allocator: std.mem.Allocator, s: []const u8) []u8 {
    return allocator.dupe(u8, s) catch @constCast(s);
}

fn trim(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t\n\r");
}

/// Finds the '<' starting the matching "</tag_name" close tag (case-insensitive),
/// scanning raw bytes rather than tokenizing — used for <script>/<style> bodies,
/// which aren't markup. Returns html.len if no close tag is found.
fn findRawTextEnd(html: []const u8, from: usize, tag_name: []const u8) usize {
    var i = from;
    while (i < html.len) : (i += 1) {
        if (html[i] == '<' and i + 1 < html.len and html[i + 1] == '/') {
            const rest = html[i + 2 ..];
            if (rest.len >= tag_name.len and eqI(rest[0..tag_name.len], tag_name)) {
                const after: u8 = if (rest.len > tag_name.len) rest[tag_name.len] else '>';
                if (after == '>' or after == ' ' or after == '\t' or after == '\n' or after == '\r') {
                    return i;
                }
            }
        }
    }
    return html.len;
}

fn eqI(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |ac, bc| {
        if (std.ascii.toLower(ac) != std.ascii.toLower(bc)) return false;
    }
    return true;
}

fn wb(dst: []u8, p: *usize, s: []const u8) void {
    const n = @min(s.len, dst.len - p.*);
    @memcpy(dst[p.*..][0..n], s[0..n]);
    p.* += n;
}

// ============================================================
//  HTML PARSER (same as core.zig)
// ============================================================

fn makeNode(doc: *Document, allocator: std.mem.Allocator, nt: NodeType, tag: []const u8) *Node {
    const n = allocator.create(Node) catch unreachable;
    n.* = .{
        .id = doc.next_id,
        .node_type = nt,
        .tag = if (tag.len > 0) dup(allocator, tag) else "",
        .text = &.{},
        .attrs = &.{},
        .children = &.{},
        .parent = null,
    };
    if (n.id - 1 < MAX_NODES) doc.node_table[n.id - 1] = n;
    doc.next_id += 1;
    doc.node_count += 1;
    return n;
}

fn addChild(parent: *Node, child: *Node, allocator: std.mem.Allocator) void {
    child.parent = parent;
    const new = allocator.alloc(*Node, parent.children.len + 1) catch unreachable;
    @memcpy(new[0..parent.children.len], parent.children);
    new[parent.children.len] = child;
    parent.children = new;
}

fn parseAttrs(s: []const u8, allocator: std.mem.Allocator) []Attr {
    if (s.len == 0) return &.{};
    var attrs: [32]Attr = undefined;
    var count: usize = 0;
    var pos: usize = 0;
    while (pos < s.len and count < 32) {
        while (pos < s.len and (s[pos] == ' ' or s[pos] == '\t' or s[pos] == '/' or s[pos] == '>')) pos += 1;
        if (pos >= s.len) break;
        const ns: usize = pos;
        while (pos < s.len and s[pos] != '=' and s[pos] != ' ' and s[pos] != '>' and s[pos] != '/') pos += 1;
        const name = trim(s[ns..pos]);
        if (name.len == 0) { pos += 1; continue; }
        var value: []const u8 = "";
        if (pos < s.len and s[pos] == '=') {
            pos += 1;
            while (pos < s.len and (s[pos] == ' ' or s[pos] == '\t')) pos += 1;
            if (pos < s.len) {
                const q = s[pos];
                if (q == '"' or q == '\'') {
                    pos += 1;
                    const vs = pos;
                    while (pos < s.len and s[pos] != q) pos += 1;
                    value = s[vs..pos];
                    if (pos < s.len) pos += 1;
                } else {
                    const vs = pos;
                    while (pos < s.len and s[pos] != ' ' and s[pos] != '>' and s[pos] != '/') pos += 1;
                    value = s[vs..pos];
                }
            }
        }
        attrs[count] = .{ .name = dup(allocator, name), .value = dup(allocator, value) };
        count += 1;
    }
    if (count == 0) return &.{};
    return allocator.dupe(Attr, attrs[0..count]) catch &.{};
}

fn parseHtml(html: []const u8, allocator: std.mem.Allocator) void {
    const doc = allocator.create(Document) catch unreachable;
    doc.* = .{};
    current_doc = doc;
    const root = makeNode(doc, allocator, .document_fragment, "");
    doc.root = root;

    var pos: usize = 0;
    var open_stack: [256]struct { tag: []const u8, node: *Node } = undefined;
    var stack_len: usize = 0;
    var current: *Node = root;
    var in_title = false;
    var title_buf: [512]u8 = undefined;
    var title_len: usize = 0;

    while (pos < html.len) {
        if (html[pos] != '<') {
            const next = std.mem.indexOfScalarPos(u8, html, pos, '<') orelse html.len;
            const t = trim(html[pos..next]);
            if (t.len > 0) {
                const tn = makeNode(doc, allocator, .text, "");
                tn.text = dupMut(allocator, t);
                addChild(current, tn, allocator);
                if (in_title) {
                    const cl = @min(t.len, title_buf.len - title_len);
                    @memcpy(title_buf[title_len..][0..cl], t[0..cl]);
                    title_len += cl;
                }
            }
            pos = next;
            continue;
        }
        if (pos + 3 < html.len and html[pos+1]=='!' and html[pos+2]=='-' and html[pos+3]=='-') {
            const end = std.mem.indexOfPos(u8, html, pos+4, "-->") orelse html.len;
            // Comments are real DOM nodes, not discarded — frameworks (React
            // hydration/Suspense in particular) use them as structural
            // markers, e.g. <!--$-->...<!--/$-->.
            const cn = makeNode(doc, allocator, .comment, "");
            cn.text = dupMut(allocator, html[@min(pos + 4, html.len)..@min(end, html.len)]);
            addChild(current, cn, allocator);
            pos = end + 3; continue;
        }
        if (pos + 8 < html.len and eqI(html[pos+1..pos+9], "!doctype")) {
            const end = std.mem.indexOfScalarPos(u8, html, pos, '>') orelse html.len;
            pos = end + 1; continue;
        }
        if (pos + 1 < html.len and html[pos+1] == '/') {
            const end = std.mem.indexOfScalarPos(u8, html, pos, '>') orelse html.len;
            const tag = trim(html[pos+2..end]);
            pos = end + 1;
            if (eqI(tag, "title")) {
                in_title = false;
                doc.title = dup(allocator, title_buf[0..title_len]);
            }
            var i: usize = stack_len;
            while (i > 0) {
                i -= 1;
                if (eqI(open_stack[i].tag, tag)) {
                    current = open_stack[i].node.parent orelse root;
                    stack_len = i; break;
                }
            }
            continue;
        }
        const tag_end = std.mem.indexOfScalarPos(u8, html, pos, '>') orelse html.len;
        const content = html[pos+1..tag_end];
        var tn_end: usize = 0;
        while (tn_end < content.len and content[tn_end] != ' ' and content[tn_end] != '/' and content[tn_end] != '>') tn_end += 1;
        const tag_name = trim(content[0..tn_end]);
        const self_close = content.len > 0 and content[content.len-1] == '/' or isVoidTag(tag_name);

        const node = makeNode(doc, allocator, .element, tag_name);
        node.attrs = parseAttrs(content[tn_end..], allocator);
        addChild(current, node, allocator);
        if (eqI(tag_name, "html")) doc.root = node;
        if (eqI(tag_name, "head")) doc.head = node;
        if (eqI(tag_name, "body")) doc.body = node;
        if (eqI(tag_name, "title")) in_title = true;

        // HTML5 "raw text" elements: their content is not markup at all (a
        // script body full of `<`/`>` from comparisons, template strings,
        // minified bundles, etc. would otherwise get tokenized as bogus
        // nested tags). Scan for the literal closing tag instead of
        // continuing normal tokenization.
        if (!self_close and (eqI(tag_name, "script") or eqI(tag_name, "style"))) {
            const content_start = tag_end + 1;
            const raw_end = findRawTextEnd(html, content_start, tag_name);
            if (raw_end > content_start) {
                const tn = makeNode(doc, allocator, .text, "");
                tn.text = dupMut(allocator, html[content_start..raw_end]);
                addChild(node, tn, allocator);
            }
            if (raw_end < html.len) {
                const close_gt = std.mem.indexOfScalarPos(u8, html, raw_end, '>') orelse html.len;
                pos = close_gt + 1;
            } else {
                pos = html.len;
            }
            continue;
        }

        if (!self_close and !isVoidTag(tag_name) and stack_len < 256) {
            open_stack[stack_len] = .{ .tag = tag_name, .node = node };
            stack_len += 1;
            current = node;
        }
        pos = tag_end + 1;
    }
    if (in_title and title_len > 0) {
        doc.title = dup(allocator, title_buf[0..title_len]);
    }
}

/// Parses an HTML fragment (e.g. an innerHTML= assignment) directly into an
/// existing node's children, reusing the same document's id/node_count
/// counters — unlike parseHtml, this never creates a new Document or
/// touches doc.root/head/body/title, since a fragment dropped into some
/// arbitrary element shouldn't reassign those.
fn parseFragment(doc: *Document, container: *Node, html: []const u8, allocator: std.mem.Allocator) void {
    var pos: usize = 0;
    var open_stack: [256]struct { tag: []const u8, node: *Node } = undefined;
    var stack_len: usize = 0;
    var current: *Node = container;

    while (pos < html.len) {
        if (html[pos] != '<') {
            const next = std.mem.indexOfScalarPos(u8, html, pos, '<') orelse html.len;
            const t = trim(html[pos..next]);
            if (t.len > 0) {
                const tn = makeNode(doc, allocator, .text, "");
                tn.text = dupMut(allocator, t);
                addChild(current, tn, allocator);
            }
            pos = next;
            continue;
        }
        if (pos + 3 < html.len and html[pos + 1] == '!' and html[pos + 2] == '-' and html[pos + 3] == '-') {
            const end = std.mem.indexOfPos(u8, html, pos + 4, "-->") orelse html.len;
            const cn = makeNode(doc, allocator, .comment, "");
            cn.text = dupMut(allocator, html[@min(pos + 4, html.len)..@min(end, html.len)]);
            addChild(current, cn, allocator);
            pos = end + 3;
            continue;
        }
        if (pos + 1 < html.len and html[pos + 1] == '/') {
            const end = std.mem.indexOfScalarPos(u8, html, pos, '>') orelse html.len;
            const tag = trim(html[pos + 2 .. end]);
            pos = end + 1;
            var i: usize = stack_len;
            while (i > 0) {
                i -= 1;
                if (eqI(open_stack[i].tag, tag)) {
                    current = open_stack[i].node.parent orelse container;
                    stack_len = i;
                    break;
                }
            }
            continue;
        }
        const tag_end = std.mem.indexOfScalarPos(u8, html, pos, '>') orelse html.len;
        const content = html[pos + 1 .. tag_end];
        var tn_end: usize = 0;
        while (tn_end < content.len and content[tn_end] != ' ' and content[tn_end] != '/' and content[tn_end] != '>') tn_end += 1;
        const tag_name = trim(content[0..tn_end]);
        const self_close = content.len > 0 and content[content.len - 1] == '/' or isVoidTag(tag_name);

        const node = makeNode(doc, allocator, .element, tag_name);
        node.attrs = parseAttrs(content[tn_end..], allocator);
        addChild(current, node, allocator);

        if (!self_close and (eqI(tag_name, "script") or eqI(tag_name, "style"))) {
            const content_start = tag_end + 1;
            const raw_end = findRawTextEnd(html, content_start, tag_name);
            if (raw_end > content_start) {
                const tn = makeNode(doc, allocator, .text, "");
                tn.text = dupMut(allocator, html[content_start..raw_end]);
                addChild(node, tn, allocator);
            }
            if (raw_end < html.len) {
                const close_gt = std.mem.indexOfScalarPos(u8, html, raw_end, '>') orelse html.len;
                pos = close_gt + 1;
            } else {
                pos = html.len;
            }
            continue;
        }

        if (!self_close and !isVoidTag(tag_name) and stack_len < 256) {
            open_stack[stack_len] = .{ .tag = tag_name, .node = node };
            stack_len += 1;
            current = node;
        }
        pos = tag_end + 1;
    }
}

// ============================================================
//  SELECTORS
// ============================================================

fn matchesSel(node: *Node, sel: []const u8) bool {
    if (node.node_type != .element) return false;
    const s = trim(sel);
    if (s.len > 1 and s[0] == '#') {
        const id = s[1..];
        for (node.attrs) |a| {
            if (eqI(a.name, "id") and eqI(a.value, id)) return true;
        }
        return false;
    }
    if (s.len > 1 and s[0] == '.') {
        const cls = s[1..];
        for (node.attrs) |a| {
            if (eqI(a.name, "class")) {
                var it = std.mem.splitSequence(u8, a.value, " ");
                while (it.next()) |c| {
                    if (eqI(c, cls)) return true;
                }
            }
        }
        return false;
    }
    if (s.len > 2 and s[0] == '[' and s[s.len-1] == ']') {
        const inner = s[1..s.len-1];
        if (std.mem.indexOfScalar(u8, inner, '=')) |eq| {
            const an = trim(inner[0..eq]);
            var av = trim(inner[eq+1..]);
            if (av.len >= 2 and ((av[0]=='"' and av[av.len-1]=='"') or (av[0]=='\'' and av[av.len-1]=='\''))) {
                av = av[1..av.len-1];
            }
            for (node.attrs) |a| {
                if (eqI(a.name, an) and eqI(a.value, av)) return true;
            }
        } else {
            for (node.attrs) |a| {
                if (eqI(a.name, trim(inner))) return true;
            }
        }
        return false;
    }
    if (std.mem.eql(u8, s, "*")) return true;
    return eqI(node.tag, s);
}

fn collectMatching(node: *Node, sel: []const u8, buf: []u32, count: *usize) void {
    if (count.* >= buf.len) return;
    if (matchesSel(node, sel)) { buf[count.*] = node.id; count.* += 1; }
    for (node.children) |c| collectMatching(c, sel, buf, count);
}

/// Looks a node up by id via the document's id table — O(1), and finds
/// nodes regardless of whether they're currently reachable from root (e.g.
/// a freshly created, still-detached element). `root` is unused; kept so
/// existing call sites (which pass doc.root as a starting point) don't need
/// to change.
fn findNodeById(root: *Node, id: u32) ?*Node {
    _ = root;
    const d = current_doc orelse return null;
    if (id == 0 or id - 1 >= MAX_NODES) return null;
    return d.node_table[id - 1];
}

// ============================================================
//  SERIALIZATION
// ============================================================

fn writeText(node: *Node, dst: []u8, p: *usize) void {
    if (node.node_type == .text) {
        const t = trim(node.text);
        if (t.len > 0) { wb(dst, p, t); if (p.* < dst.len) { dst[p.*] = ' '; p.* += 1; } }
        return;
    }
    if (node.node_type == .element and isSkipTag(node.tag)) return;
    for (node.children) |c| writeText(c, dst, p);
}

fn writeHtml(node: *Node, dst: []u8, p: *usize) void {
    if (p.* >= dst.len) return;
    switch (node.node_type) {
        .element => {
            wb(dst, p, "<"); wb(dst, p, node.tag);
            for (node.attrs) |a| { wb(dst, p, " "); wb(dst, p, a.name); wb(dst, p, "=\""); wb(dst, p, a.value); wb(dst, p, "\""); }
            wb(dst, p, ">");
            for (node.children) |c| writeHtml(c, dst, p);
            if (!isVoidTag(node.tag)) { wb(dst, p, "</"); wb(dst, p, node.tag); wb(dst, p, ">"); }
        },
        .text => { wb(dst, p, node.text); },
        .comment => { wb(dst, p, "<!--"); wb(dst, p, node.text); wb(dst, p, "-->"); },
        .document_fragment, .document => { for (node.children) |c| writeHtml(c, dst, p); },
    }
}

fn writeMd(node: *Node, dst: []u8, p: *usize) void {
    if (p.* >= dst.len) return;
    const isBlock = node.node_type == .element and (
        eqI(node.tag, "p") or eqI(node.tag, "div") or
        eqI(node.tag, "h1") or eqI(node.tag, "h2") or
        eqI(node.tag, "h3") or eqI(node.tag, "h4") or
        eqI(node.tag, "h5") or eqI(node.tag, "h6") or
        eqI(node.tag, "li") or eqI(node.tag, "br") or
        eqI(node.tag, "hr") or eqI(node.tag, "blockquote") or
        eqI(node.tag, "section") or eqI(node.tag, "article"));

    if (isBlock and p.* > 0 and p.* < dst.len) { dst[p.*] = '\n'; p.* += 1; }
    if (node.node_type == .element) {
        const t = node.tag;
        if (t.len == 2 and t[0] == 'h' and t[1] >= '1' and t[1] <= '6') {
            const hashes = [_]u8{'#', '#', '#', '#', '#', '#'};
            wb(dst, p, hashes[0 .. t[1] - '0']); wb(dst, p, " ");
        }
        if (eqI(t, "li")) wb(dst, p, "- ");
        if (eqI(t, "a")) wb(dst, p, "[");
        if (eqI(t, "strong") or eqI(t, "b")) wb(dst, p, "**");
        if (eqI(t, "em") or eqI(t, "i")) wb(dst, p, "*");
        if (eqI(t, "hr")) wb(dst, p, "\n---\n");
        if (isSkipTag(t)) return;
        for (node.children) |c| writeMd(c, dst, p);
        if (eqI(t, "a")) {
            wb(dst, p, "](");
            for (node.attrs) |a| { if (eqI(a.name, "href")) { wb(dst, p, a.value); break; } }
            wb(dst, p, ")");
        }
        if (eqI(t, "strong") or eqI(t, "b")) wb(dst, p, "**");
        if (eqI(t, "em") or eqI(t, "i")) wb(dst, p, "*");
        if (isBlock and p.* < dst.len) { dst[p.*] = '\n'; p.* += 1; }
    } else if (node.node_type == .text) {
        wb(dst, p, node.text);
    }
}

// ============================================================
//  CSS COMBINATORS (Phase 3 enhancement)
// ============================================================

// Supports: "div > p", "div p", "div + p", "div ~ p"
fn matchesComplexSelector(node: *Node, sel: []const u8) bool {
    // Split on combinators: > + ~ and space (descendant)
    // For now, fall back to simple selector
    return matchesSel(node, sel);
}

fn collectComplex(node: *Node, sel: []const u8, buf: []u32, count: *usize) void {
    if (count.* >= buf.len) return;
    if (matchesComplexSelector(node, sel)) { buf[count.*] = node.id; count.* += 1; }
    for (node.children) |c| collectComplex(c, sel, buf, count);
}

// ============================================================
//  EXPORTED WASM API — CORE (same as core.zig)
// ============================================================

export fn kk_init() bool {
    fixed_alloc = std.heap.FixedBufferAllocator.init(&arena_memory);
    arena_buf = fixed_alloc.allocator();
    return true;
}

export fn kk_destroy() void {
    current_doc = null;
    result_len = 0;
}

export fn kk_parse_html(ptr: [*]const u8, len: u32) bool {
    fixed_alloc.reset();
    parseHtml(ptr[0..len], arena_buf);
    return true;
}

export fn kk_get_title_ptr() [*]const u8 {
    const t = if (current_doc) |d| d.title else "";
    @memcpy(result_buf[0..@min(t.len, result_buf.len)], t);
    result_len = @intCast(@min(t.len, result_buf.len));
    return result_buf[0..];
}
export fn kk_get_title_len() u32 { return result_len; }

export fn kk_get_text_ptr() [*]const u8 {
    var pos: usize = 0;
    if (current_doc) |d| { if (d.root) |r| writeText(r, &result_buf, &pos); }
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_get_text_len() u32 { return result_len; }

export fn kk_get_html_ptr() [*]const u8 {
    var pos: usize = 0;
    if (current_doc) |d| { if (d.root) |r| writeHtml(r, &result_buf, &pos); }
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_get_html_len() u32 { return result_len; }

export fn kk_get_markdown_ptr() [*]const u8 {
    var pos: usize = 0;
    if (current_doc) |d| { if (d.root) |r| writeMd(r, &result_buf, &pos); }
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_get_markdown_len() u32 { return result_len; }

export fn kk_get_node_count() u32 {
    return if (current_doc) |d| d.node_count else 0;
}

export fn kk_query_selector(sel_ptr: [*]const u8, sel_len: u32) [*]const u32 {
    var ids: [4096]u32 = undefined;
    var count: usize = 0;
    if (current_doc) |d| { if (d.root) |r| {
        // Support comma-separated selector lists (e.g. ".a, .b"), unioned and deduped.
        var it = std.mem.splitScalar(u8, sel_ptr[0..sel_len], ',');
        while (it.next()) |part| {
            const trimmed = trim(part);
            if (trimmed.len == 0) continue;
            var part_ids: [4096]u32 = undefined;
            var part_count: usize = 0;
            collectMatching(r, trimmed, &part_ids, &part_count);
            for (part_ids[0..part_count]) |id| {
                if (count >= ids.len) break;
                var already = false;
                for (ids[0..count]) |existing| { if (existing == id) { already = true; break; } }
                if (!already) { ids[count] = id; count += 1; }
            }
        }
    }}
    const bytes = count * @sizeOf(u32);
    @memcpy(result_buf[0..bytes], @as([*]const u8, @ptrCast(&ids))[0..bytes]);
    result_len = @intCast(count);
    return @as([*]const u32, @ptrCast(@alignCast(&result_buf)));
}
export fn kk_query_selector_count() u32 { return result_len; }

export fn kk_node_tag(id: u32) [*]const u8 {
    result_len = 0;
    if (current_doc) |d| { if (d.root) |r| {
        if (findNodeById(r, id)) |n| {
            @memcpy(result_buf[0..@min(n.tag.len, result_buf.len)], n.tag);
            result_len = @intCast(n.tag.len);
        }
    }}
    return result_buf[0..];
}
export fn kk_node_tag_len() u32 { return result_len; }

export fn kk_node_text(id: u32) [*]const u8 {
    var pos: usize = 0;
    if (current_doc) |d| { if (d.root) |r| {
        if (findNodeById(r, id)) |n| writeText(n, &result_buf, &pos);
    }}
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_node_text_len() u32 { return result_len; }

export fn kk_node_attr(id: u32, name_ptr: [*]const u8, name_len: u32) [*]const u8 {
    result_len = 0;
    if (current_doc) |d| { if (d.root) |r| {
        if (findNodeById(r, id)) |n| {
            const name = name_ptr[0..name_len];
            for (n.attrs) |a| {
                if (eqI(a.name, name)) {
                    @memcpy(result_buf[0..@min(a.value.len, result_buf.len)], a.value);
                    result_len = @intCast(a.value.len); break;
                }
            }
        }
    }}
    return result_buf[0..];
}
export fn kk_node_attr_len() u32 { return result_len; }

export fn kk_node_child_count(id: u32) u32 {
    if (current_doc) |d| { if (d.root) |r| {
        if (findNodeById(r, id)) |n| return @intCast(n.children.len);
    }}
    return 0;
}

export fn kk_node_children(id: u32) [*]const u32 {
    var ids: [1024]u32 = undefined;
    var count: usize = 0;
    if (current_doc) |d| { if (d.root) |r| {
        if (findNodeById(r, id)) |n| {
            for (n.children) |c| { if (count < ids.len) { ids[count] = c.id; count += 1; } }
        }
    }}
    const bytes = count * @sizeOf(u32);
    @memcpy(result_buf[0..bytes], @as([*]const u8, @ptrCast(&ids))[0..bytes]);
    result_len = @intCast(count);
    return @as([*]const u32, @ptrCast(@alignCast(&result_buf)));
}

export fn kk_version() [*]const u8 {
 const v = "0.2.0";
    @memcpy(result_buf[0..v.len], v);
    result_len = @intCast(v.len);
    return result_buf[0..];
}
export fn kk_version_len() u32 { return result_len; }

export fn kk_log(msg_ptr: [*]const u8, msg_len: u32) void {
    hostLog(msg_ptr, msg_len);
}

// ============================================================
//  EXPORTED WASM API — DOM MUTATION (for JS DOM bindings)
// ============================================================

fn docNode(id: u32) ?*Node {
    const d = current_doc orelse return null;
    const r = d.root orelse return null;
    return findNodeById(r, id);
}

/// Creates a new, detached element node and returns its id. 0 on failure.
export fn kk_dom_create_element(tag_ptr: [*]const u8, tag_len: u32) u32 {
    const d = current_doc orelse return 0;
    const node = makeNode(d, arena_buf, .element, tag_ptr[0..tag_len]);
    return node.id;
}

/// Creates a new, detached text node and returns its id. 0 on failure.
export fn kk_dom_create_text(text_ptr: [*]const u8, text_len: u32) u32 {
    const d = current_doc orelse return 0;
    const node = makeNode(d, arena_buf, .text, "");
    node.text = dupMut(arena_buf, text_ptr[0..text_len]);
    return node.id;
}

export fn kk_dom_set_attr(id: u32, name_ptr: [*]const u8, name_len: u32, val_ptr: [*]const u8, val_len: u32) bool {
    const n = docNode(id) orelse return false;
    const name = name_ptr[0..name_len];
    const value = dup(arena_buf, val_ptr[0..val_len]);
    for (n.attrs) |*a| {
        if (eqI(a.name, name)) {
            a.value = value;
            return true;
        }
    }
    const new_attrs = arena_buf.alloc(Attr, n.attrs.len + 1) catch return false;
    @memcpy(new_attrs[0..n.attrs.len], n.attrs);
    new_attrs[n.attrs.len] = .{ .name = dup(arena_buf, name), .value = value };
    n.attrs = new_attrs;
    return true;
}

export fn kk_dom_remove_attr(id: u32, name_ptr: [*]const u8, name_len: u32) bool {
    const n = docNode(id) orelse return false;
    const name = name_ptr[0..name_len];
    const new_attrs = arena_buf.alloc(Attr, n.attrs.len) catch return false;
    var count: usize = 0;
    for (n.attrs) |a| {
        if (!eqI(a.name, name)) {
            new_attrs[count] = a;
            count += 1;
        }
    }
    n.attrs = new_attrs[0..count];
    return true;
}

/// Replaces a node's children with a single text node.
export fn kk_dom_set_text_content(id: u32, ptr: [*]const u8, len: u32) bool {
    const d = current_doc orelse return false;
    const n = docNode(id) orelse return false;
    const tn = makeNode(d, arena_buf, .text, "");
    tn.text = dupMut(arena_buf, ptr[0..len]);
    tn.parent = n;
    const new_children = arena_buf.alloc(*Node, 1) catch return false;
    new_children[0] = tn;
    n.children = new_children;
    return true;
}

/// Serializes a node's children (not the node itself) as HTML — innerHTML getter.
export fn kk_dom_get_inner_html(id: u32) [*]const u8 {
    var pos: usize = 0;
    if (docNode(id)) |n| {
        for (n.children) |c| writeHtml(c, &result_buf, &pos);
    }
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_dom_get_inner_html_len() u32 { return result_len; }

/// Parses `html` as a fragment and replaces the node's children — innerHTML setter.
export fn kk_dom_set_inner_html(id: u32, ptr: [*]const u8, len: u32) bool {
    const d = current_doc orelse return false;
    const n = docNode(id) orelse return false;
    n.children = &.{};
    parseFragment(d, n, ptr[0..len], arena_buf);
    return true;
}

/// Appends child to parent, detaching it from any previous parent first.
export fn kk_dom_append_child(parent_id: u32, child_id: u32) bool {
    const parent = docNode(parent_id) orelse return false;
    const child = docNode(child_id) orelse return false;
    if (child.parent) |old| {
        const new_children = arena_buf.alloc(*Node, old.children.len) catch return false;
        var count: usize = 0;
        for (old.children) |c| {
            if (c != child) {
                new_children[count] = c;
                count += 1;
            }
        }
        old.children = new_children[0..count];
    }
    addChild(parent, child, arena_buf);
    return true;
}

/// Removes a node from its parent (a no-op if it has none).
export fn kk_dom_remove_child(id: u32) bool {
    const n = docNode(id) orelse return false;
    const parent = n.parent orelse return true;
    const new_children = arena_buf.alloc(*Node, parent.children.len) catch return false;
    var count: usize = 0;
    for (parent.children) |c| {
        if (c != n) {
            new_children[count] = c;
            count += 1;
        }
    }
    parent.children = new_children[0..count];
    n.parent = null;
    return true;
}

/// Returns the parent's node id, or 0 if there is none.
export fn kk_dom_parent(id: u32) u32 {
    const n = docNode(id) orelse return 0;
    return if (n.parent) |p| p.id else 0;
}

/// DOM nodeType: 1=element, 3=text, 8=comment, 9=document, 11=document_fragment. 0 if not found.
export fn kk_dom_node_type(id: u32) u8 {
    const n = docNode(id) orelse return 0;
    return @intFromEnum(n.node_type);
}

export fn kk_dom_root_id() u32 {
    const d = current_doc orelse return 0;
    return if (d.root) |r| r.id else 0;
}
export fn kk_dom_head_id() u32 {
    const d = current_doc orelse return 0;
    return if (d.head) |h| h.id else 0;
}
export fn kk_dom_body_id() u32 {
    const d = current_doc orelse return 0;
    return if (d.body) |b| b.id else 0;
}
export fn kk_dom_set_title(ptr: [*]const u8, len: u32) void {
    const d = current_doc orelse return;
    d.title = dup(arena_buf, ptr[0..len]);
}

// ============================================================
//  EXPORTED WASM API — QUICKJS
// ============================================================

export fn kk_js_init() c_int {
    return qjs_init();
}

export fn kk_js_destroy() void {
    qjs_destroy();
}

export fn kk_js_eval(code_ptr: [*]const u8, code_len: u32) c_int {
    return qjs_eval(code_ptr, @intCast(code_len));
}

export fn kk_js_get_result() [*]const u8 {
    const ptr = qjs_get_result();
    const len: usize = @intCast(qjs_get_result_len());
    const copy_len = @min(len, result_buf.len);
    @memcpy(result_buf[0..copy_len], ptr[0..copy_len]);
    result_len = @intCast(copy_len);
    return result_buf[0..];
}
export fn kk_js_get_result_len() u32 { return result_len; }

export fn kk_js_get_error() [*]const u8 {
    const ptr = qjs_get_error();
    const len: usize = @intCast(qjs_get_error_len());
    const copy_len = @min(len, result_buf.len);
    @memcpy(result_buf[0..copy_len], ptr[0..copy_len]);
    result_len = @intCast(copy_len);
    return result_buf[0..];
}
export fn kk_js_get_error_len() u32 { return result_len; }

export fn kk_js_last_type() c_int {
    return qjs_last_result_type();
}

/// Drains QuickJS's microtask queue (Promise reactions) and flushes one
/// round of the setTimeout queue. Returns how many callbacks ran.
export fn kk_js_run_pending_jobs() c_int {
    return qjs_run_pending_jobs();
}

/// Settles a sandboxed fetch(url)'s pending Promise with a real, host-fetched
/// response. `id` is the request id the JS-side fetch() queued.
export fn kk_js_resolve_fetch(id: u32, status: u32, body_ptr: [*]const u8, body_len: u32) c_int {
    return qjs_resolve_fetch(id, status, body_ptr, body_len);
}
export fn kk_js_reject_fetch(id: u32, msg_ptr: [*]const u8, msg_len: u32) c_int {
    return qjs_reject_fetch(id, msg_ptr, msg_len);
}

// ============================================================
//  EXPORTED WASM API — FETCH INTEROP
// ============================================================

/// Request a fetch from the host. Returns a request ID.
export fn kk_fetch_request(url_ptr: [*]const u8, url_len: u32, method_ptr: [*]const u8, method_len: u32) u32 {
    return hostFetch(url_ptr, url_len, method_ptr, method_len);
}

/// Called by the JS host to deliver fetch response data.
/// Stores the response body and status for retrieval.
export fn kk_fetch_complete(status: u32, body_ptr: [*]const u8, body_len: u32) void {
    fetch_status_code = status;
    const copy_len: usize = @min(@as(usize, body_len), input_buf.len);
    @memcpy(input_buf[0..copy_len], body_ptr[0..copy_len]);
    fetch_body_len = @intCast(copy_len);
    fetch_pending = false;
}

export fn kk_get_fetch_status() u32 { return fetch_status_code; }

export fn kk_get_fetch_body_ptr() [*]const u8 {
    @memcpy(result_buf[0..fetch_body_len], input_buf[0..fetch_body_len]);
    result_len = fetch_body_len;
    return result_buf[0..];
}
export fn kk_get_fetch_body_len() u32 { return fetch_body_len; }
