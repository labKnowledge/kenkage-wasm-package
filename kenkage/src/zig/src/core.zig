// kenkage-core: Pure Zig browser engine compiled to wasm32-freestanding

const std = @import("std");

// ============================================================
//  EXTERNAL HOST FUNCTIONS (provided by JS at load time)
// ============================================================

extern fn hostLog(ptr: [*]const u8, len: u32) void;

// ============================================================
//  GLOBAL STATE
// ============================================================

// 1MB arena for DOM
var arena_memory: [1024 * 1024]u8 = undefined;
// 64KB input buffer for host-provided data (fetch responses, etc.)
var input_buf: [64 * 1024]u8 = undefined;
var arena_buf: std.mem.Allocator = undefined;
var fixed_alloc: std.heap.FixedBufferAllocator = undefined;

var current_doc: ?*Document = null;
// Aligned buffer for u32 results
var result_buf: [256 * 1024]u8 align(4) = undefined;
var result_len: u32 = 0;

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

const Document = struct {
    root: ?*Node = null,
    head: ?*Node = null,
    body: ?*Node = null,
    title: []const u8 = "",
    node_count: u32 = 0,
    next_id: u32 = 1,
};

// ============================================================
//  HELPERS
// ============================================================

fn isVoidTag(tag: []const u8) bool {
    const void_tags = [_][]const u8{
        "area",  "base",  "br",   "col",   "embed", "hr",
        "img",   "input", "link", "meta",  "param",
        "source","track", "wbr",
    };
    for (void_tags) |vt| {
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
//  HTML PARSER
// ============================================================

fn makeNode(allocator: std.mem.Allocator, nt: NodeType, tag: []const u8) *Node {
    const doc = current_doc.?;
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
    const root = makeNode(allocator, .document_fragment, "");
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
                const tn = makeNode(allocator, .text, "");
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
        // Comment — kept as a real DOM node (not discarded): frameworks
        // (React hydration/Suspense in particular) use these as structural
        // markers, e.g. <!--$-->...<!--/$-->.
        if (pos + 3 < html.len and html[pos+1]=='!' and html[pos+2]=='-' and html[pos+3]=='-') {
            const end = std.mem.indexOfPos(u8, html, pos+4, "-->") orelse html.len;
            const cn = makeNode(allocator, .comment, "");
            cn.text = dupMut(allocator, html[@min(pos + 4, html.len)..@min(end, html.len)]);
            addChild(current, cn, allocator);
            pos = end + 3;
            continue;
        }
        // DOCTYPE
        if (pos + 8 < html.len and eqI(html[pos+1..pos+9], "!doctype")) {
            const end = std.mem.indexOfScalarPos(u8, html, pos, '>') orelse html.len;
            pos = end + 1;
            continue;
        }
        // Closing tag
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
                    stack_len = i;
                    break;
                }
            }
            continue;
        }
        // Opening tag
        const tag_end = std.mem.indexOfScalarPos(u8, html, pos, '>') orelse html.len;
        const content = html[pos+1..tag_end];
        var tn_end: usize = 0;
        while (tn_end < content.len and content[tn_end] != ' ' and content[tn_end] != '/' and content[tn_end] != '>') tn_end += 1;
        const tag_name = trim(content[0..tn_end]);
        const self_close = content.len > 0 and (content[content.len-1] == '/') or isVoidTag(tag_name);

        const node = makeNode(allocator, .element, tag_name);
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
                const tn = makeNode(allocator, .text, "");
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

// ============================================================
//  SELECTOR MATCHING
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
    if (matchesSel(node, sel)) {
        buf[count.*] = node.id;
        count.* += 1;
    }
    for (node.children) |c| collectMatching(c, sel, buf, count);
}

fn findNodeById(root: *Node, id: u32) ?*Node {
    if (root.id == id) return root;
    for (root.children) |c| {
        if (findNodeById(c, id)) |found| return found;
    }
    return null;
}

// ============================================================
//  SERIALIZATION
// ============================================================

fn writeText(node: *Node, dst: []u8, p: *usize) void {
    if (node.node_type == .text) {
        const t = trim(node.text);
        if (t.len > 0) {
            wb(dst, p, t);
            if (p.* < dst.len) { dst[p.*] = ' '; p.* += 1; }
        }
        return;
    }
    if (node.node_type == .element and isSkipTag(node.tag)) return;
    for (node.children) |c| writeText(c, dst, p);
}

fn writeHtml(node: *Node, dst: []u8, p: *usize) void {
    if (p.* >= dst.len) return;
    switch (node.node_type) {
        .element => {
            wb(dst, p, "<");
            wb(dst, p, node.tag);
            for (node.attrs) |a| {
                wb(dst, p, " ");
                wb(dst, p, a.name);
                wb(dst, p, "=\"");
                wb(dst, p, a.value);
                wb(dst, p, "\"");
            }
            wb(dst, p, ">");
            for (node.children) |c| writeHtml(c, dst, p);
            if (!isVoidTag(node.tag)) {
                wb(dst, p, "</");
                wb(dst, p, node.tag);
                wb(dst, p, ">");
            }
        },
        .text => {
            wb(dst, p, node.text);
        },
        .comment => {
            wb(dst, p, "<!--");
            wb(dst, p, node.text);
            wb(dst, p, "-->");
        },
        .document_fragment, .document => {
            for (node.children) |c| writeHtml(c, dst, p);
        },
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
            wb(dst, p, hashes[0 .. t[1] - '0']);
            wb(dst, p, " ");
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
            for (node.attrs) |a| {
                if (eqI(a.name, "href")) { wb(dst, p, a.value); break; }
            }
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
//  EXPORTED WASM API
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
    if (current_doc) |d| {
        if (d.root) |r| writeText(r, &result_buf, &pos);
    }
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_get_text_len() u32 { return result_len; }

export fn kk_get_html_ptr() [*]const u8 {
    var pos: usize = 0;
    if (current_doc) |d| {
        if (d.root) |r| writeHtml(r, &result_buf, &pos);
    }
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_get_html_len() u32 { return result_len; }

export fn kk_get_markdown_ptr() [*]const u8 {
    var pos: usize = 0;
    if (current_doc) |d| {
        if (d.root) |r| writeMd(r, &result_buf, &pos);
    }
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
    if (current_doc) |d| {
        if (d.root) |r| {
            if (findNodeById(r, id)) |n| {
                @memcpy(result_buf[0..@min(n.tag.len, result_buf.len)], n.tag);
                result_len = @intCast(n.tag.len);
            }
        }
    }
    return result_buf[0..];
}
export fn kk_node_tag_len() u32 { return result_len; }

export fn kk_node_text(id: u32) [*]const u8 {
    var pos: usize = 0;
    if (current_doc) |d| {
        if (d.root) |r| {
            if (findNodeById(r, id)) |n| writeText(n, &result_buf, &pos);
        }
    }
    result_len = @intCast(pos);
    return result_buf[0..];
}
export fn kk_node_text_len() u32 { return result_len; }

export fn kk_node_attr(id: u32, name_ptr: [*]const u8, name_len: u32) [*]const u8 {
    result_len = 0;
    if (current_doc) |d| {
        if (d.root) |r| {
            if (findNodeById(r, id)) |n| {
                const name = name_ptr[0..name_len];
                for (n.attrs) |a| {
                    if (eqI(a.name, name)) {
                        @memcpy(result_buf[0..@min(a.value.len, result_buf.len)], a.value);
                        result_len = @intCast(a.value.len);
                        break;
                    }
                }
            }
        }
    }
    return result_buf[0..];
}
export fn kk_node_attr_len() u32 { return result_len; }

export fn kk_node_child_count(id: u32) u32 {
    if (current_doc) |d| {
        if (d.root) |r| {
            if (findNodeById(r, id)) |n| return @intCast(n.children.len);
        }
    }
    return 0;
}

export fn kk_node_children(id: u32) [*]const u32 {
    var ids: [1024]u32 = undefined;
    var count: usize = 0;
    if (current_doc) |d| {
        if (d.root) |r| {
            if (findNodeById(r, id)) |n| {
                for (n.children) |c| {
                    if (count < ids.len) { ids[count] = c.id; count += 1; }
                }
            }
        }
    }
    const bytes = count * @sizeOf(u32);
    @memcpy(result_buf[0..bytes], @as([*]const u8, @ptrCast(&ids))[0..bytes]);
    result_len = @intCast(count);
    return @as([*]const u32, @ptrCast(@alignCast(&result_buf)));
}

// ============================================================
//  FETCH INTEROP
// ============================================================

var fetch_id_counter: u32 = 0;
var fetch_url_ptr: [*]const u8 = undefined;
var fetch_url_len: u32 = 0;

/// Request a fetch from the host browser. Returns request ID.
export fn kk_fetch_request(url_ptr: [*]const u8, url_len: u32, method_ptr: [*]const u8, method_len: u32) u32 {
    fetch_id_counter += 1;
    fetch_url_ptr = url_ptr;
    fetch_url_len = url_len;
    _ = method_ptr; _ = method_len;
    return fetch_id_counter;
}

/// Called by JS host to deliver fetch response. Stores body for retrieval.
export fn kk_fetch_complete(status: u32, body_ptr: [*]const u8, body_len: u32) void {
    const copy_len = @min(body_len, @as(u32, @intCast(input_buf.len)));
    @memcpy(input_buf[0..copy_len], body_ptr[0..copy_len]);
    fetch_body_len = @intCast(copy_len);
    fetch_status = status;
}

var fetch_status: u32 = 0;
var fetch_body_len: u32 = 0;

export fn kk_get_fetch_status() u32 { return fetch_status; }
export fn kk_get_fetch_body_ptr() [*]const u8 {
    @memcpy(result_buf[0..fetch_body_len], input_buf[0..fetch_body_len]);
    result_len = fetch_body_len;
    return result_buf[0..];
}
export fn kk_get_fetch_body_len() u32 { return fetch_body_len; }

var eval_request_id: u32 = 0;

/// Signal to host: execute JavaScript (host delegates to browser/Node eval)
export fn kk_eval_js_request(code_ptr: [*]const u8, code_len: u32) u32 {
    eval_request_id += 1;
    _ = code_ptr; _ = code_len;
    return eval_request_id;
}

/// Called by JS host with eval result
export fn kk_eval_js_complete(success: c_int, result_ptr: [*]const u8, res_len: u32) void {
    const rlen = res_len;
    @memcpy(result_buf[0..@min(rlen, result_buf.len)], result_ptr[0..@min(rlen, result_buf.len)]);
    result_len = @min(rlen, @as(u32, result_buf.len));
    eval_success = success != 0;
}

var eval_success: bool = false;

export fn kk_get_eval_success() c_int {
    return @intFromBool(eval_success);
}

// ============================================================
//  VERSION
// ============================================================

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
