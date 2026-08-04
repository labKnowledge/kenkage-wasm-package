/*
 * qjs_engine.c - QuickJS wrapper for kenkage
 * Minimal C API for Zig FFI - avoids stdio.h for freestanding WASM
 */

#include "quickjs.h"
#include <string.h>
#include <stdint.h>

/* Minimal string.h stubs if needed */
#ifndef memcpy
#define memcpy __builtin_memcpy
#endif
#ifndef memset
#define memset __builtin_memset
#endif
#ifndef strlen
#define strlen(s) (__builtin_strlen(s))
#endif
#ifndef strcmp
#define strcmp(a,b) (__builtin_strcmp(a,b))
#endif

static JSRuntime *g_rt = NULL;
static JSContext *g_ctx = NULL;
static char g_result[65536];
static char g_error[65536];

/* Minimal integer to string */
static int int_to_str(char *buf, int bufsize, int64_t val) {
    if (bufsize == 0) return 0;
    int neg = 0;
    if (val < 0) { neg = 1; val = -val; }
    char tmp[21];
    int pos = 0;
    if (val == 0) { tmp[pos++] = '0'; }
    else { while (val > 0 && pos < 20) { tmp[pos++] = '0' + (int)(val % 10); val /= 10; } }
    int out = 0;
    if (neg && out < bufsize - 1) buf[out++] = '-';
    while (pos > 0 && out < bufsize - 1) buf[out++] = tmp[--pos];
    buf[out] = '\0';
    return out;
}

/* Minimal double to string (simple %g-like formatting) */
static int double_to_str(char *buf, int bufsize, double val) {
    /* Handle special cases */
    if (val != val) { memcpy(buf, "NaN", 4); return 3; }
    if (val == (__builtin_inf())) { memcpy(buf, "Infinity", 9); return 8; }
    if (val == (-__builtin_inf())) { memcpy(buf, "-Infinity", 10); return 9; }
    
    /* For integers that fit in int64, use integer format */
    int64_t ival = (int64_t)val;
    if ((double)ival == val && ival >= -1000000000LL && ival <= 1000000000LL) {
        return int_to_str(buf, bufsize, ival);
    }
    
    /* Simple floating point: up to 6 significant digits */
    if (val == 0.0) { memcpy(buf, "0", 2); return 1; }
    
    int neg = 0;
    if (val < 0) { neg = 1; val = -val; }
    
    int out = 0;
    if (neg && out < bufsize - 1) buf[out++] = '-';
    
    /* Normalize to [1, 10) */
    int exp = 0;
    if (val >= 10.0) { while (val >= 10.0) { val /= 10.0; exp++; } }
    else if (val < 1.0 && val > 0.0) { while (val < 1.0) { val *= 10.0; exp--; } }
    
    /* Print digits */
    for (int i = 0; i < 6 && out < bufsize - 1; i++) {
        if (i == 1 && out < bufsize - 1) buf[out++] = '.';
        int d = (int)val;
        if (d > 9) d = 9;
        if (d < 0) d = 0;
        buf[out++] = '0' + d;
        val = (val - d) * 10.0;
    }
    
    /* Remove trailing zeros after decimal point */
    while (out > 0 && buf[out-1] == '0' && out > 1 && buf[out-2] != '.') out--;
    
    buf[out] = '\0';
    return out;
}

static void setup_dom_bindings(JSContext *ctx);

static void kk_clear_modules(void);
static JSModuleDef *kk_module_loader(JSContext *ctx, const char *module_name, void *opaque);
static char *kk_module_normalize(JSContext *ctx, const char *base_name, const char *name, void *opaque);

/* Creates g_ctx (g_rt must already exist) with DOM bindings and the module
 * loader wired up. Shared by qjs_init (first-ever setup) and qjs_reset
 * (a fresh context for a new page load on an already-running engine). */
static int kk_init_context(void) {
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx) return 0;
    setup_dom_bindings(g_ctx);
    /* Registered after the DOM prelude so kk_module_normalize's `URL` lookup
     * (used only when a module is actually loaded, i.e. after init has
     * fully completed) always finds the polyfill in place. */
    JS_SetModuleLoaderFunc(g_rt, kk_module_normalize, kk_module_loader, NULL);
    return 1;
}

int qjs_init(void) {
    g_rt = JS_NewRuntime();
    if (!g_rt) return 0;
    if (!kk_init_context()) {
        JS_FreeRuntime(g_rt);
        g_rt = NULL;
        return 0;
    }
    return 1;
}

void qjs_destroy(void) {
    if (g_ctx) { kk_clear_modules(); JS_FreeContext(g_ctx); g_ctx = NULL; }
    if (g_rt) { JS_FreeRuntime(g_rt); g_rt = NULL; }
}

/* Tears down and recreates the JS context (keeping the runtime) so a new
 * page load starts from a genuinely clean realm — no leftover globals,
 * timers, listeners, or (critically) QuickJS's own internal loaded-module
 * cache, which is keyed by resolved specifier and would otherwise silently
 * hand back an already-evaluated module from a *previous* loadPage() call
 * whenever two page loads happen to resolve the same import URL. Matches
 * how a real browser tab gets a fresh realm on every navigation. */
int qjs_reset(void) {
    if (g_ctx) {
        kk_clear_modules();
        JS_FreeContext(g_ctx);
        g_ctx = NULL;
    }
    if (!g_rt) {
        g_rt = JS_NewRuntime();
        if (!g_rt) return 0;
    }
    return kk_init_context();
}

int qjs_eval(const char *code, int code_len) {
    if (!g_ctx) return -2;
    g_result[0] = '\0';
    g_error[0] = '\0';

    JSValue val = JS_Eval(g_ctx, code, (size_t)code_len, "<eval>", JS_EVAL_TYPE_GLOBAL);

    if (JS_IsException(val)) {
        JSValue exc_val = JS_GetException(g_ctx);
        const char *err_str = JS_ToCString(g_ctx, exc_val);
        if (err_str) {
            int len = (int)strlen(err_str);
            if (len > (int)sizeof(g_error) - 1) len = (int)sizeof(g_error) - 1;
            memcpy(g_error, err_str, len);
            g_error[len] = '\0';
            JS_FreeCString(g_ctx, err_str);
        }
        JS_FreeValue(g_ctx, exc_val);
        return -1;
    }

    /* Convert result to string */
    if (JS_IsString(val)) {
        const char *s = JS_ToCString(g_ctx, val);
        if (s) {
            int len = (int)strlen(s);
            if (len > (int)sizeof(g_result) - 1) len = (int)sizeof(g_result) - 1;
            memcpy(g_result, s, len);
            g_result[len] = '\0';
            JS_FreeCString(g_ctx, s);
        }
    } else if (JS_IsBool(val)) {
        int b = JS_VALUE_GET_INT(val);
        /* memcpy length must include the NUL terminator, or strlen() below
         * reads past it into whatever a previous, longer result left behind. */
        if (b) { memcpy(g_result, "true", 5); }
        else { memcpy(g_result, "false", 6); }
    } else if (JS_IsNull(val)) {
        memcpy(g_result, "null", 5);
    } else if (JS_IsUndefined(val)) {
        memcpy(g_result, "undefined", 10);
    } else if (JS_IsNumber(val)) {
        int tag = JS_VALUE_GET_NORM_TAG(val);
        if (tag == JS_TAG_INT) {
            int_to_str(g_result, sizeof(g_result), JS_VALUE_GET_INT(val));
        } else {
            double_to_str(g_result, sizeof(g_result), JS_VALUE_GET_FLOAT64(val));
        }
    } else {
        g_result[0] = '['; g_result[1] = 'o'; g_result[2] = 'b';
        g_result[3] = 'j'; g_result[4] = 'e'; g_result[5] = 'c';
        g_result[6] = 't'; g_result[7] = '\0';
    }

    JS_FreeValue(g_ctx, val);
    return 0;
}

const char *qjs_get_result(void) { return g_result; }
int qjs_get_result_len(void) { return (int)strlen(g_result); }

const char *qjs_get_error(void) { return g_error; }
int qjs_get_error_len(void) { return (int)strlen(g_error); }

/* Set a global variable from a JSON value string */
int qjs_set_global(const char *name, const char *json_val) {
    if (!g_ctx) return -2;
    JSValue v = JS_Eval(g_ctx, json_val, strlen(json_val), "<json>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) { JS_FreeValue(g_ctx, JS_GetException(g_ctx)); return -1; }
    JS_SetPropertyStr(g_ctx, JS_GetGlobalObject(g_ctx), name, v);
    return 0;
}

/* Get a global variable as a string */
int qjs_get_global(const char *name) {
    if (!g_ctx) return -2;
    g_result[0] = '\0';
    JSValue global = JS_GetGlobalObject(g_ctx);
    JSValue val = JS_GetPropertyStr(g_ctx, global, name);
    JS_FreeValue(g_ctx, global);
    
    if (JS_IsException(val)) { JS_FreeValue(g_ctx, JS_GetException(g_ctx)); return -1; }
    if (JS_IsString(val)) {
        const char *s = JS_ToCString(g_ctx, val);
        if (s) {
            int len = (int)strlen(s);
            if (len > (int)sizeof(g_result) - 1) len = (int)sizeof(g_result) - 1;
            memcpy(g_result, s, len);
            g_result[len] = '\0';
            JS_FreeCString(g_ctx, s);
        }
    }
    JS_FreeValue(g_ctx, val);
    return 0;
}

/* ============================================================
 * ES MODULE SUPPORT
 * ============================================================
 * QuickJS's module loader callback (JSModuleLoaderFunc) is synchronous —
 * unlike fetch() below, which suspends behind a real Promise while the
 * host performs a network round-trip, the loader cannot itself await
 * anything crossing back out to the host. So the entire static import
 * graph must be pre-fetched and registered here via qjs_register_module()
 * *before* qjs_eval_module() runs; the loader only ever does a synchronous
 * lookup in this table. (Dynamic `import()` doesn't have this constraint
 * since it's Promise-based already, but isn't wired up yet — out of scope
 * for this pass.)
 */
#define KK_MAX_MODULES 256
static char *g_module_urls[KK_MAX_MODULES];
static char *g_module_srcs[KK_MAX_MODULES];
static int g_module_count = 0;

static void kk_clear_modules(void) {
    for (int i = 0; i < g_module_count; i++) {
        if (g_module_urls[i]) js_free(g_ctx, g_module_urls[i]);
        if (g_module_srcs[i]) js_free(g_ctx, g_module_srcs[i]);
        g_module_urls[i] = NULL;
        g_module_srcs[i] = NULL;
    }
    g_module_count = 0;
}

/* Called by the host at the start of every fresh loadPage() crawl so a
 * previous page's modules can't leak into (or collide with) the next. */
void qjs_clear_modules(void) {
    if (!g_ctx) return;
    kk_clear_modules();
}

/* Registers pre-fetched source for a resolved module URL (last write wins
 * for a repeated url, so re-registering mid-crawl is harmless). */
int qjs_register_module(const char *url, int url_len, const char *src, int src_len) {
    if (!g_ctx) return -2;
    for (int i = 0; i < g_module_count; i++) {
        if ((int)strlen(g_module_urls[i]) == url_len && memcmp(g_module_urls[i], url, url_len) == 0) {
            char *src_copy = js_malloc(g_ctx, (size_t)src_len + 1);
            if (!src_copy) return -2;
            memcpy(src_copy, src, src_len);
            src_copy[src_len] = '\0';
            js_free(g_ctx, g_module_srcs[i]);
            g_module_srcs[i] = src_copy;
            return 0;
        }
    }
    if (g_module_count >= KK_MAX_MODULES) return -3;
    char *url_copy = js_malloc(g_ctx, (size_t)url_len + 1);
    char *src_copy = js_malloc(g_ctx, (size_t)src_len + 1);
    if (!url_copy || !src_copy) {
        if (url_copy) js_free(g_ctx, url_copy);
        if (src_copy) js_free(g_ctx, src_copy);
        return -2;
    }
    memcpy(url_copy, url, url_len); url_copy[url_len] = '\0';
    memcpy(src_copy, src, src_len); src_copy[src_len] = '\0';
    g_module_urls[g_module_count] = url_copy;
    g_module_srcs[g_module_count] = src_copy;
    g_module_count++;
    return 0;
}

/* Minimal import.meta — just `url` and `main`, no realpath/file: URL
 * dance (module names here are always already-absolute http(s) URLs
 * supplied by the host, unlike quickjs's own CLI which loads from disk). */
static void kk_set_import_meta(JSContext *ctx, JSValueConst func_val, int is_main) {
    if (JS_VALUE_GET_TAG(func_val) != JS_TAG_MODULE) return;
    JSModuleDef *m = JS_VALUE_GET_PTR(func_val);
    JSAtom name_atom = JS_GetModuleName(ctx, m);
    const char *name = JS_AtomToCString(ctx, name_atom);
    JS_FreeAtom(ctx, name_atom);
    JSValue meta_obj = JS_GetImportMeta(ctx, m);
    if (!JS_IsException(meta_obj)) {
        JS_DefinePropertyValueStr(ctx, meta_obj, "url", JS_NewString(ctx, name ? name : ""), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, meta_obj, "main", JS_NewBool(ctx, is_main), JS_PROP_C_W_E);
        JS_FreeValue(ctx, meta_obj);
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    if (name) JS_FreeCString(ctx, name);
}

/* Resolves a specifier against the importing module's URL using the
 * sandbox's own URL polyfill (already loaded by the DOM prelude) instead
 * of re-implementing URL joining in C. Falls back to the raw specifier on
 * failure (e.g. a bare specifier with no import map) so the loader below
 * reports a clean "module not found" instead of this crashing. */
static char *kk_module_normalize(JSContext *ctx, const char *base_name, const char *name, void *opaque) {
    (void)opaque;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__kk_norm_name", JS_NewString(ctx, name));
    JS_SetPropertyStr(ctx, global, "__kk_norm_base", base_name ? JS_NewString(ctx, base_name) : JS_UNDEFINED);
    JS_FreeValue(ctx, global);

    static const char norm_code[] =
        "(function(){"
        "  try { return new URL(__kk_norm_name, __kk_norm_base).href; }"
        "  catch (e) { return __kk_norm_name; }"
        "})()";
    JSValue result = JS_Eval(ctx, norm_code, strlen(norm_code), "<module-normalize>", JS_EVAL_TYPE_GLOBAL);
    char *out = NULL;
    if (!JS_IsException(result)) {
        const char *s = JS_ToCString(ctx, result);
        if (s) {
            size_t len = strlen(s);
            out = js_malloc(ctx, len + 1);
            if (out) memcpy(out, s, len + 1);
            JS_FreeCString(ctx, s);
        }
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    JS_FreeValue(ctx, result);
    return out;
}

/* The loader never does I/O itself — every specifier it's asked for must
 * already have been fetched and registered via qjs_register_module()
 * during the host's pre-crawl. Anything missing (a bare specifier with no
 * import map, a dynamic import the crawler couldn't see statically)
 * surfaces as a real ReferenceError instead of silently failing. */
static JSModuleDef *kk_module_loader(JSContext *ctx, const char *module_name, void *opaque) {
    (void)opaque;
    for (int i = 0; i < g_module_count; i++) {
        if (strcmp(g_module_urls[i], module_name) == 0) {
            const char *src = g_module_srcs[i];
            JSValue func_val = JS_Eval(ctx, src, strlen(src), module_name,
                                       JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
            if (JS_IsException(func_val)) return NULL;
            kk_set_import_meta(ctx, func_val, 0);
            JSModuleDef *m = JS_VALUE_GET_PTR(func_val);
            JS_FreeValue(ctx, func_val);
            return m;
        }
    }
    JS_ThrowReferenceError(ctx, "could not resolve module '%s' (not pre-fetched)", module_name);
    return NULL;
}

/* Evaluates `code` (already fetched by the host) as an ES module whose
 * resolved name is `url` — mirrors quickjs's own CLI eval_buf() for
 * modules: compile-only first so import.meta can be set on it, then run. */
int qjs_eval_module(const char *url, int url_len, const char *code, int code_len) {
    if (!g_ctx) return -2;
    g_result[0] = '\0';
    g_error[0] = '\0';

    char name_buf[2048];
    int n = url_len < (int)sizeof(name_buf) - 1 ? url_len : (int)sizeof(name_buf) - 1;
    memcpy(name_buf, url, n);
    name_buf[n] = '\0';

    JSValue func_val = JS_Eval(g_ctx, code, (size_t)code_len, name_buf,
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(func_val)) {
        JSValue exc_val = JS_GetException(g_ctx);
        const char *err_str = JS_ToCString(g_ctx, exc_val);
        if (err_str) {
            int len = (int)strlen(err_str);
            if (len > (int)sizeof(g_error) - 1) len = (int)sizeof(g_error) - 1;
            memcpy(g_error, err_str, len);
            g_error[len] = '\0';
            JS_FreeCString(g_ctx, err_str);
        }
        JS_FreeValue(g_ctx, exc_val);
        return -1;
    }

    kk_set_import_meta(g_ctx, func_val, 1);
    JSValue result = JS_EvalFunction(g_ctx, func_val); /* consumes func_val */
    if (JS_IsException(result)) {
        JSValue exc_val = JS_GetException(g_ctx);
        const char *err_str = JS_ToCString(g_ctx, exc_val);
        if (err_str) {
            int len = (int)strlen(err_str);
            if (len > (int)sizeof(g_error) - 1) len = (int)sizeof(g_error) - 1;
            memcpy(g_error, err_str, len);
            g_error[len] = '\0';
            JS_FreeCString(g_ctx, err_str);
        }
        JS_FreeValue(g_ctx, exc_val);
        JS_FreeValue(g_ctx, result);
        return -1;
    }
    JS_FreeValue(g_ctx, result);
    return 0;
}

/* ============================================================
 * DOM BINDINGS — expose the Zig DOM tree to QuickJS as document/Node
 * ============================================================
 * These extern declarations refer to functions exported by full.zig
 * (`export fn kk_...`). Both are compiled into the same wasm module, so
 * symbol names resolve directly at link time — no FFI marshaling needed,
 * pointers are just offsets into the one shared linear memory.
 */
extern uint32_t kk_dom_create_element(const char *tag, uint32_t tag_len);
extern uint32_t kk_dom_create_text(const char *text, uint32_t text_len);
extern int kk_dom_set_attr(uint32_t id, const char *name, uint32_t name_len, const char *val, uint32_t val_len);
extern int kk_dom_remove_attr(uint32_t id, const char *name, uint32_t name_len);
extern int kk_dom_set_text_content(uint32_t id, const char *text, uint32_t text_len);
extern const char *kk_dom_get_inner_html(uint32_t id);
extern uint32_t kk_dom_get_inner_html_len(void);
extern int kk_dom_set_inner_html(uint32_t id, const char *html, uint32_t html_len);
extern int kk_dom_append_child(uint32_t parent_id, uint32_t child_id);
extern int kk_dom_insert_before(uint32_t parent_id, uint32_t new_id, uint32_t reference_id);
extern int kk_dom_remove_child(uint32_t id);
extern uint32_t kk_dom_parent(uint32_t id);
extern uint8_t kk_dom_node_type(uint32_t id);
extern uint32_t kk_dom_root_id(void);
extern uint32_t kk_dom_head_id(void);
extern uint32_t kk_dom_body_id(void);
extern void kk_dom_set_title(const char *ptr, uint32_t len);

extern const char *kk_node_tag(uint32_t id);
extern uint32_t kk_node_tag_len(void);
extern const char *kk_node_text(uint32_t id);
extern uint32_t kk_node_text_len(void);
extern const char *kk_node_attr(uint32_t id, const char *name, uint32_t name_len);
extern uint32_t kk_node_attr_len(void);
extern uint32_t kk_node_child_count(uint32_t id);
extern const uint32_t *kk_node_children(uint32_t id);
extern const uint32_t *kk_query_selector(const char *sel, uint32_t sel_len);
extern uint32_t kk_query_selector_count(void);
extern const char *kk_get_title_ptr(void);
extern uint32_t kk_get_title_len(void);

static JSClassID g_node_class_id;
static JSValue g_node_proto;
static JSValue g_document_obj;

/* A Node/Element wrapper's opaque data is just the u32 node id, stored
 * directly as a pointer value (safe on wasm32: pointers are 4 bytes). */
static uint32_t node_id_of(JSValueConst v) {
    return (uint32_t)(uintptr_t)JS_GetOpaque(v, g_node_class_id);
}

static JSValue wrap_node(JSContext *ctx, uint32_t id) {
    if (id == 0) return JS_NULL;
    JSValue obj = JS_NewObjectProtoClass(ctx, g_node_proto, g_node_class_id);
    if (JS_IsException(obj)) return obj;
    JS_SetOpaque(obj, (void *)(uintptr_t)id);
    return obj;
}

static JSValue js_str(JSContext *ctx, const char *ptr, uint32_t len) {
    return JS_NewStringLen(ctx, ptr, len);
}

static uint32_t id_arg(JSContext *ctx, JSValueConst v) {
    /* Accepts either a wrapped Node or a bare number (defensive — real
     * scripts always pass Nodes, but this avoids a crash either way). */
    if (JS_GetOpaque(v, g_node_class_id) != NULL) return node_id_of(v);
    int32_t n = 0;
    JS_ToInt32(ctx, &n, v);
    return (uint32_t)n;
}

/* ---- Node/Element prototype: getters/setters ---- */

static JSValue node_get_nodeType(JSContext *ctx, JSValueConst this_val) {
    return JS_NewInt32(ctx, kk_dom_node_type(node_id_of(this_val)));
}

static JSValue node_get_nodeName(JSContext *ctx, JSValueConst this_val) {
    uint32_t id = node_id_of(this_val);
    uint8_t nt = kk_dom_node_type(id);
    if (nt == 3) return JS_NewString(ctx, "#text");
    if (nt == 8) return JS_NewString(ctx, "#comment");
    const char *tag = kk_node_tag(id);
    uint32_t len = kk_node_tag_len();
    /* Real DOM: element tagName/nodeName is uppercase. */
    char buf[128];
    uint32_t n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
    for (uint32_t i = 0; i < n; i++) {
        char c = tag[i];
        buf[i] = (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c;
    }
    return js_str(ctx, buf, n);
}

static JSValue node_get_tagName(JSContext *ctx, JSValueConst this_val) {
    if (kk_dom_node_type(node_id_of(this_val)) != 1) return JS_UNDEFINED;
    return node_get_nodeName(ctx, this_val);
}

static JSValue node_get_textContent(JSContext *ctx, JSValueConst this_val) {
    uint32_t id = node_id_of(this_val);
    const char *p = kk_node_text(id);
    return js_str(ctx, p, kk_node_text_len());
}

static JSValue node_set_textContent(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    uint32_t id = node_id_of(this_val);
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, val);
    if (s) {
        kk_dom_set_text_content(id, s, (uint32_t)len);
        JS_FreeCString(ctx, s);
    }
    return JS_UNDEFINED;
}

static JSValue node_get_innerHTML(JSContext *ctx, JSValueConst this_val) {
    uint32_t id = node_id_of(this_val);
    const char *p = kk_dom_get_inner_html(id);
    return js_str(ctx, p, kk_dom_get_inner_html_len());
}

static JSValue node_set_innerHTML(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    uint32_t id = node_id_of(this_val);
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, val);
    if (s) {
        kk_dom_set_inner_html(id, s, (uint32_t)len);
        JS_FreeCString(ctx, s);
    }
    return JS_UNDEFINED;
}

static JSValue node_get_parentNode(JSContext *ctx, JSValueConst this_val) {
    uint32_t pid = kk_dom_parent(node_id_of(this_val));
    return wrap_node(ctx, pid);
}

static JSValue node_get_childNodes(JSContext *ctx, JSValueConst this_val) {
    uint32_t id = node_id_of(this_val);
    const uint32_t *ids = kk_node_children(id);
    uint32_t count = kk_query_selector_count();
    JSValue arr = JS_NewArray(ctx);
    for (uint32_t i = 0; i < count; i++) {
        JS_SetPropertyUint32(ctx, arr, i, wrap_node(ctx, ids[i]));
    }
    return arr;
}

static JSValue node_get_children(JSContext *ctx, JSValueConst this_val) {
    uint32_t id = node_id_of(this_val);
    const uint32_t *ids = kk_node_children(id);
    uint32_t count = kk_query_selector_count();
    /* children[] is element-only per spec; childNodes[] includes text. */
    uint32_t elem_ids[1024];
    uint32_t elem_count = 0;
    for (uint32_t i = 0; i < count && elem_count < 1024; i++) {
        if (kk_dom_node_type(ids[i]) == 1) elem_ids[elem_count++] = ids[i];
    }
    JSValue arr = JS_NewArray(ctx);
    for (uint32_t i = 0; i < elem_count; i++) {
        JS_SetPropertyUint32(ctx, arr, i, wrap_node(ctx, elem_ids[i]));
    }
    return arr;
}

/* ---- Node/Element prototype: methods ---- */

static JSValue node_getAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_NULL;
    uint32_t id = node_id_of(this_val);
    size_t len;
    const char *name = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!name) return JS_NULL;
    const char *val = kk_node_attr(id, name, (uint32_t)len);
    uint32_t val_len = kk_node_attr_len();
    JS_FreeCString(ctx, name);
    if (val_len == 0) return JS_NULL;
    return js_str(ctx, val, val_len);
}

static JSValue node_setAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 2) return JS_UNDEFINED;
    uint32_t id = node_id_of(this_val);
    size_t nlen, vlen;
    const char *name = JS_ToCStringLen(ctx, &nlen, argv[0]);
    const char *val = JS_ToCStringLen(ctx, &vlen, argv[1]);
    if (name && val) kk_dom_set_attr(id, name, (uint32_t)nlen, val, (uint32_t)vlen);
    if (name) JS_FreeCString(ctx, name);
    if (val) JS_FreeCString(ctx, val);
    return JS_UNDEFINED;
}

static JSValue node_removeAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_UNDEFINED;
    uint32_t id = node_id_of(this_val);
    size_t len;
    const char *name = JS_ToCStringLen(ctx, &len, argv[0]);
    if (name) {
        kk_dom_remove_attr(id, name, (uint32_t)len);
        JS_FreeCString(ctx, name);
    }
    return JS_UNDEFINED;
}

static JSValue node_hasAttribute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_NewBool(ctx, 0);
    uint32_t id = node_id_of(this_val);
    size_t len;
    const char *name = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!name) return JS_NewBool(ctx, 0);
    kk_node_attr(id, name, (uint32_t)len);
    int has = kk_node_attr_len() > 0;
    JS_FreeCString(ctx, name);
    return JS_NewBool(ctx, has);
}

static JSValue node_appendChild(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_UNDEFINED;
    kk_dom_append_child(node_id_of(this_val), id_arg(ctx, argv[0]));
    return JS_DupValue(ctx, argv[0]);
}

/* insertBefore(newNode, referenceNode) — referenceNode may be omitted or
 * null/undefined, matching real DOM semantics ("insert at the end"); id_arg
 * already maps non-Node values through JS_ToInt32, where null/undefined
 * both resolve to 0, the same sentinel kk_dom_insert_before treats as
 * "no reference". */
static JSValue node_insertBefore(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_UNDEFINED;
    uint32_t reference_id = argc >= 2 ? id_arg(ctx, argv[1]) : 0;
    kk_dom_insert_before(node_id_of(this_val), id_arg(ctx, argv[0]), reference_id);
    return JS_DupValue(ctx, argv[0]);
}

static JSValue node_removeChild(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_UNDEFINED;
    kk_dom_remove_child(id_arg(ctx, argv[0]));
    return JS_DupValue(ctx, argv[0]);
}

static JSValue node_remove(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)argc; (void)argv;
    kk_dom_remove_child(node_id_of(this_val));
    return JS_UNDEFINED;
}

/* querySelector/All scoped to descendants: the engine's query is
 * document-wide, so scope it by walking each match's ancestor chain and
 * keeping only those under `this` (and excluding `this` itself). */
static int is_descendant_of(uint32_t candidate_id, uint32_t ancestor_id) {
    uint32_t p = kk_dom_parent(candidate_id);
    while (p != 0) {
        if (p == ancestor_id) return 1;
        p = kk_dom_parent(p);
    }
    return 0;
}

static JSValue node_querySelectorAll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSValue arr = JS_NewArray(ctx);
    if (argc < 1) return arr;
    uint32_t self_id = node_id_of(this_val);
    size_t len;
    const char *sel = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!sel) return arr;
    const uint32_t *ids = kk_query_selector(sel, (uint32_t)len);
    uint32_t count = kk_query_selector_count();
    uint32_t matched_ids[4096];
    uint32_t mc = 0;
    for (uint32_t i = 0; i < count && mc < 4096; i++) {
        if (ids[i] != self_id && is_descendant_of(ids[i], self_id)) matched_ids[mc++] = ids[i];
    }
    JS_FreeCString(ctx, sel);
    for (uint32_t i = 0; i < mc; i++) {
        JS_SetPropertyUint32(ctx, arr, i, wrap_node(ctx, matched_ids[i]));
    }
    return arr;
}

static JSValue node_querySelector(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_NULL;
    uint32_t self_id = node_id_of(this_val);
    size_t len;
    const char *sel = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!sel) return JS_NULL;
    const uint32_t *ids = kk_query_selector(sel, (uint32_t)len);
    uint32_t count = kk_query_selector_count();
    uint32_t found = 0;
    for (uint32_t i = 0; i < count; i++) {
        if (ids[i] != self_id && is_descendant_of(ids[i], self_id)) { found = ids[i]; break; }
    }
    JS_FreeCString(ctx, sel);
    return wrap_node(ctx, found);
}

static const JSCFunctionListEntry node_proto_funcs[] = {
    JS_CGETSET_DEF("nodeType", node_get_nodeType, NULL),
    JS_CGETSET_DEF("nodeName", node_get_nodeName, NULL),
    JS_CGETSET_DEF("tagName", node_get_tagName, NULL),
    JS_CGETSET_DEF("textContent", node_get_textContent, node_set_textContent),
    JS_CGETSET_DEF("innerHTML", node_get_innerHTML, node_set_innerHTML),
    JS_CGETSET_DEF("parentNode", node_get_parentNode, NULL),
    JS_CGETSET_DEF("parentElement", node_get_parentNode, NULL),
    JS_CGETSET_DEF("childNodes", node_get_childNodes, NULL),
    JS_CGETSET_DEF("children", node_get_children, NULL),
    JS_CFUNC_DEF("getAttribute", 1, node_getAttribute),
    JS_CFUNC_DEF("setAttribute", 2, node_setAttribute),
    JS_CFUNC_DEF("removeAttribute", 1, node_removeAttribute),
    JS_CFUNC_DEF("hasAttribute", 1, node_hasAttribute),
    JS_CFUNC_DEF("appendChild", 1, node_appendChild),
    JS_CFUNC_DEF("insertBefore", 2, node_insertBefore),
    JS_CFUNC_DEF("removeChild", 1, node_removeChild),
    JS_CFUNC_DEF("remove", 0, node_remove),
    JS_CFUNC_DEF("querySelector", 1, node_querySelector),
    JS_CFUNC_DEF("querySelectorAll", 1, node_querySelectorAll),
};

/* ---- document global ---- */

static JSValue doc_getElementById(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    size_t len;
    const char *id_str = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!id_str) return JS_NULL;
    char sel[256];
    sel[0] = '#';
    size_t n = len < sizeof(sel) - 2 ? len : sizeof(sel) - 2;
    memcpy(sel + 1, id_str, n);
    JS_FreeCString(ctx, id_str);
    const uint32_t *ids = kk_query_selector(sel, (uint32_t)(n + 1));
    uint32_t count = kk_query_selector_count();
    return wrap_node(ctx, count > 0 ? ids[0] : 0);
}

static JSValue doc_querySelector(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    size_t len;
    const char *sel = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!sel) return JS_NULL;
    const uint32_t *ids = kk_query_selector(sel, (uint32_t)len);
    uint32_t count = kk_query_selector_count();
    uint32_t first = count > 0 ? ids[0] : 0;
    JS_FreeCString(ctx, sel);
    return wrap_node(ctx, first);
}

static JSValue doc_querySelectorAll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    JSValue arr = JS_NewArray(ctx);
    if (argc < 1) return arr;
    size_t len;
    const char *sel = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!sel) return arr;
    const uint32_t *ids = kk_query_selector(sel, (uint32_t)len);
    uint32_t count = kk_query_selector_count();
    uint32_t buf[4096];
    uint32_t n = count < 4096 ? count : 4096;
    memcpy(buf, ids, n * sizeof(uint32_t));
    JS_FreeCString(ctx, sel);
    for (uint32_t i = 0; i < n; i++) {
        JS_SetPropertyUint32(ctx, arr, i, wrap_node(ctx, buf[i]));
    }
    return arr;
}

static JSValue doc_createElement(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    size_t len;
    const char *tag = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!tag) return JS_NULL;
    uint32_t id = kk_dom_create_element(tag, (uint32_t)len);
    JS_FreeCString(ctx, tag);
    return wrap_node(ctx, id);
}

static JSValue doc_createTextNode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    size_t len;
    const char *text = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!text) return JS_NULL;
    uint32_t id = kk_dom_create_text(text, (uint32_t)len);
    JS_FreeCString(ctx, text);
    return wrap_node(ctx, id);
}

static JSValue doc_get_body(JSContext *ctx, JSValueConst this_val) {
    (void)this_val;
    return wrap_node(ctx, kk_dom_body_id());
}
static JSValue doc_get_head(JSContext *ctx, JSValueConst this_val) {
    (void)this_val;
    return wrap_node(ctx, kk_dom_head_id());
}
static JSValue doc_get_documentElement(JSContext *ctx, JSValueConst this_val) {
    (void)this_val;
    return wrap_node(ctx, kk_dom_root_id());
}
static JSValue doc_get_title(JSContext *ctx, JSValueConst this_val) {
    (void)this_val;
    return js_str(ctx, kk_get_title_ptr(), kk_get_title_len());
}
static JSValue doc_set_title(JSContext *ctx, JSValueConst this_val, JSValueConst val) {
    (void)this_val;
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, val);
    if (s) {
        kk_dom_set_title(s, (uint32_t)len);
        JS_FreeCString(ctx, s);
    }
    return JS_UNDEFINED;
}

/* Exposed as global __kk_wrap_node(id) — lets the host-side page-load
 * orchestrator set document.currentScript to the real wrapped element
 * for whichever <script> it's about to execute. */
static JSValue js_wrap_node_by_id(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    int32_t id = 0;
    JS_ToInt32(ctx, &id, argv[0]);
    return wrap_node(ctx, (uint32_t)id);
}

static const JSCFunctionListEntry document_funcs[] = {
    JS_CFUNC_DEF("getElementById", 1, doc_getElementById),
    JS_CFUNC_DEF("querySelector", 1, doc_querySelector),
    JS_CFUNC_DEF("querySelectorAll", 1, doc_querySelectorAll),
    JS_CFUNC_DEF("createElement", 1, doc_createElement),
    JS_CFUNC_DEF("createTextNode", 1, doc_createTextNode),
    JS_CGETSET_DEF("body", doc_get_body, NULL),
    JS_CGETSET_DEF("head", doc_get_head, NULL),
    JS_CGETSET_DEF("documentElement", doc_get_documentElement, NULL),
    JS_CGETSET_DEF("title", doc_get_title, doc_set_title),
};

/* Minimal console — extremely commonly assumed to exist by real scripts. */
static JSValue console_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_UNDEFINED;
}
static const JSCFunctionListEntry console_funcs[] = {
    JS_CFUNC_DEF("log", 0, console_log),
    JS_CFUNC_DEF("warn", 0, console_log),
    JS_CFUNC_DEF("error", 0, console_log),
    JS_CFUNC_DEF("info", 0, console_log),
    JS_CFUNC_DEF("debug", 0, console_log),
};

/* JS-level convenience layer on top of the native primitives above:
 * id/className/classList, style (no-op store, no CSS engine by design),
 * a minimal addEventListener/dispatchEvent, and setTimeout/setInterval as
 * a one-shot flush queue (this engine renders a page once — there is no
 * persistent event loop, so real delays aren't meaningful; callbacks are
 * simply run, in registration order, when the host flushes the queue
 * after script execution settles). window is aliased to globalThis. */
static const char *DOM_PRELUDE =
    "globalThis.window = globalThis;\n"
    "globalThis.self = globalThis;\n"
    /* Pragmatic WHATWG URL subset — covers the common cases real bundles
     * hit (relative resolution against a base, origin/pathname/search,
     * searchParams) without claiming full spec fidelity (no IPv6 hosts,
     * userinfo, or full percent-encoding normalization). */
    "globalThis.URLSearchParams = class URLSearchParams {\n"
    "  constructor(init) {\n"
    "    this.__entries = [];\n"
    "    const s = typeof init === 'string' ? (init.startsWith('?') ? init.slice(1) : init) : '';\n"
    "    if (s) for (const pair of s.split('&')) {\n"
    "      const eq = pair.indexOf('=');\n"
    "      const k = eq >= 0 ? pair.slice(0, eq) : pair;\n"
    "      const v = eq >= 0 ? pair.slice(eq + 1) : '';\n"
    "      this.__entries.push([decodeURIComponent(k), decodeURIComponent(v.replace(/\\+/g, ' '))]);\n"
    "    }\n"
    "  }\n"
    "  get(name) { const e = this.__entries.find(e => e[0] === name); return e ? e[1] : null; }\n"
    "  getAll(name) { return this.__entries.filter(e => e[0] === name).map(e => e[1]); }\n"
    "  has(name) { return this.__entries.some(e => e[0] === name); }\n"
    "  set(name, value) { this.__entries = this.__entries.filter(e => e[0] !== name); this.__entries.push([name, String(value)]); }\n"
    "  append(name, value) { this.__entries.push([name, String(value)]); }\n"
    "  delete(name) { this.__entries = this.__entries.filter(e => e[0] !== name); }\n"
    "  toString() { return this.__entries.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }\n"
    "  [Symbol.iterator]() { return this.__entries[Symbol.iterator](); }\n"
    "};\n"
    /* Collapses '.'/'..' path segments (RFC 3986 §5.2.4-style), e.g.
     * '/a/./b/../c' -> '/a/c'. Without this, a relative specifier like
     * './helper.js' resolves to '.../​./helper.js' (the literal dot
     * segment left in place) instead of '.../helper.js' — harmless for
     * display, but a real bug for anything that treats the resolved URL
     * as an exact lookup key (module resolution does exactly that: see
     * kk_module_normalize in qjs_engine.c, which relies on this class). */
    "function __kk_normalize_url_path(path) {\n"
    "  const isAbsolute = path.startsWith('/');\n"
    "  const out = [];\n"
    "  for (const part of path.split('/')) {\n"
    "    if (part === '.' || part === '') continue;\n"
    "    if (part === '..') { out.pop(); continue; }\n"
    "    out.push(part);\n"
    "  }\n"
    "  let result = out.join('/');\n"
    "  if (path.endsWith('/') && !result.endsWith('/')) result += '/';\n"
    "  return (isAbsolute ? '/' : '') + result || '/';\n"
    "}\n"
    "globalThis.URL = class URL {\n"
    "  constructor(url, base) {\n"
    "    let full = String(url);\n"
    "    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(full);\n"
    "    if (!hasScheme) {\n"
    "      if (base === undefined) throw new TypeError('Invalid URL: ' + full);\n"
    "      const b = base instanceof URL ? base : new URL(base);\n"
    "      if (full.startsWith('//')) full = b.protocol + full;\n"
    "      else if (full.startsWith('/')) full = b.origin + full;\n"
    "      else if (full.startsWith('?')) full = b.origin + b.pathname + full;\n"
    "      else if (full.startsWith('#')) full = b.origin + b.pathname + b.search + full;\n"
    "      else full = b.origin + b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1) + full;\n"
    "    }\n"
    "    const m = full.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)\\/\\/(([^/?#:]*)(:(\\d+))?)?([^?#]*)(\\?[^#]*)?(#.*)?$/);\n"
    "    if (!m) throw new TypeError('Invalid URL: ' + full);\n"
    "    this.protocol = m[1];\n"
    "    this.host = m[2] || '';\n"
    "    this.hostname = m[3] || '';\n"
    "    this.port = m[5] || '';\n"
    "    this.pathname = __kk_normalize_url_path(m[6] || '/');\n"
    "    this.search = m[7] || '';\n"
    "    this.hash = m[8] || '';\n"
    "    this.origin = this.protocol + '//' + this.host;\n"
    "    this.href = this.protocol + '//' + this.host + this.pathname + this.search + this.hash;\n"
    "    this.searchParams = new URLSearchParams(this.search);\n"
    "  }\n"
    "  toString() { return this.href; }\n"
    "  toJSON() { return this.href; }\n"
    "};\n"
    "Object.defineProperty(__LPWNodeProto, 'id', {\n"
    "  get() { return this.getAttribute('id') || ''; },\n"
    "  set(v) { this.setAttribute('id', String(v)); },\n"
    "});\n"
    "Object.defineProperty(__LPWNodeProto, 'className', {\n"
    "  get() { return this.getAttribute('class') || ''; },\n"
    "  set(v) { this.setAttribute('class', String(v)); },\n"
    "});\n"
    "Object.defineProperty(__LPWNodeProto, 'firstChild', {\n"
    "  get() { return this.childNodes[0] ?? null; },\n"
    "});\n"
    "Object.defineProperty(__LPWNodeProto, 'lastChild', {\n"
    "  get() { const c = this.childNodes; return c.length ? c[c.length - 1] : null; },\n"
    "});\n"
    "Object.defineProperty(__LPWNodeProto, 'firstElementChild', {\n"
    "  get() { return this.children[0] ?? null; },\n"
    "});\n"
    "Object.defineProperty(__LPWNodeProto, 'lastElementChild', {\n"
    "  get() { const c = this.children; return c.length ? c[c.length - 1] : null; },\n"
    "});\n"
    "Object.defineProperty(__LPWNodeProto, 'style', {\n"
    "  get() {\n"
    "    if (!this.__style) this.__style = new Proxy({}, {\n"
    "      get: (t, k) => t[k] ?? '',\n"
    "      set: (t, k, v) => { t[k] = v; return true; },\n"
    "    });\n"
    "    return this.__style;\n"
    "  },\n"
    "});\n"
    "Object.defineProperty(__LPWNodeProto, 'classList', {\n"
    "  get() {\n"
    "    const self = this;\n"
    "    function cls() { return (self.className || '').split(/\\s+/).filter(Boolean); }\n"
    "    return {\n"
    "      add: (...names) => { const s = new Set(cls()); names.forEach(n => s.add(n)); self.className = [...s].join(' '); },\n"
    "      remove: (...names) => { const s = new Set(cls()); names.forEach(n => s.delete(n)); self.className = [...s].join(' '); },\n"
    "      toggle: (name, force) => { const s = new Set(cls()); const has = s.has(name); const want = force === undefined ? !has : force; if (want) s.add(name); else s.delete(name); self.className = [...s].join(' '); return want; },\n"
    "      contains: (name) => cls().includes(name),\n"
    "    };\n"
    "  },\n"
    "});\n"
    /* Real constructors for the globals page scripts most commonly reference
     * directly (`new Event(...)`) or use for feature-detection/instanceof
     * checks (`typeof Document !== 'undefined'`, `x instanceof HTMLElement`).
     * These were previously absent entirely — scripts that touched them hit
     * a bare ReferenceError. Kept minimal (no bubbling/capturing phases,
     * since there's no real render tree to propagate through) rather than a
     * full spec implementation. */
    "globalThis.EventTarget = class EventTarget {};\n"
    "globalThis.Node = class Node extends EventTarget {};\n"
    "globalThis.Element = class Element extends Node {};\n"
    "globalThis.HTMLElement = class HTMLElement extends Element {};\n"
    "Object.setPrototypeOf(__LPWNodeProto, HTMLElement.prototype);\n"
    "globalThis.Document = class Document extends Node {};\n"
    "Object.setPrototypeOf(document, Document.prototype);\n"
    /* getElementsByTagName is extremely common in the wild (the classic
     * Google Analytics async-loader snippet and PostHog's init snippet both
     * use it — `m=s.getElementsByTagName(o)[0]`) and was simply missing. A
     * bare tag name is already a valid CSS selector, so this is a direct
     * alias rather than a new query path — same pragmatic-subset spirit as
     * URL/URLSearchParams above (a real getElementsByTagName result is a
     * *live* HTMLCollection; this returns a static array, close enough for
     * scripts that just index into element [0]). */
    "document.getElementsByTagName = function (tag) { return this.querySelectorAll(tag); };\n"
    "__LPWNodeProto.getElementsByTagName = function (tag) { return this.querySelectorAll(tag); };\n"
    "globalThis.Event = class Event {\n"
    "  constructor(type, init) {\n"
    "    this.type = String(type);\n"
    "    this.bubbles = !!(init && init.bubbles);\n"
    "    this.cancelable = !!(init && init.cancelable);\n"
    "    this.defaultPrevented = false;\n"
    "    this.target = null;\n"
    "    this.currentTarget = null;\n"
    "    this.timeStamp = Date.now();\n"
    "  }\n"
    "  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }\n"
    "  stopPropagation() {}\n"
    "  stopImmediatePropagation() {}\n"
    "};\n"
    "globalThis.CustomEvent = class CustomEvent extends Event {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    this.detail = (init && 'detail' in init) ? init.detail : null;\n"
    "  }\n"
    "};\n"
    "__LPWNodeProto.__listeners = null;\n"
    "__LPWNodeProto.addEventListener = function (type, fn) {\n"
    "  (this.__listeners ??= {})[type] ??= [];\n"
    "  this.__listeners[type].push(fn);\n"
    "};\n"
    "__LPWNodeProto.removeEventListener = function (type, fn) {\n"
    "  const l = this.__listeners && this.__listeners[type];\n"
    "  if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }\n"
    "};\n"
    "__LPWNodeProto.dispatchEvent = function (evOrType) {\n"
    "  const ev = typeof evOrType === 'string' ? new Event(evOrType) : evOrType;\n"
    "  ev.target = this; ev.currentTarget = this;\n"
    "  const l = this.__listeners && this.__listeners[ev.type];\n"
    "  if (l) for (const fn of l.slice()) { try { fn.call(this, ev); } catch (e) {} }\n"
    "  return true;\n"
    "};\n"
    "document.__listeners = null;\n"
    "document.addEventListener = __LPWNodeProto.addEventListener.bind(document);\n"
    "document.removeEventListener = __LPWNodeProto.removeEventListener.bind(document);\n"
    "document.dispatchEvent = __LPWNodeProto.dispatchEvent.bind(document);\n"
    /* window (== globalThis) needs its own listener store and bound methods,
     * same as document — `window.addEventListener('load', ...)` is at least
     * as common as the document-level form (PostHog's own init snippet uses
     * exactly this) and was simply missing before. */
    "globalThis.__listeners = null;\n"
    "globalThis.addEventListener = __LPWNodeProto.addEventListener.bind(globalThis);\n"
    "globalThis.removeEventListener = __LPWNodeProto.removeEventListener.bind(globalThis);\n"
    "globalThis.dispatchEvent = __LPWNodeProto.dispatchEvent.bind(globalThis);\n"
    "globalThis.__kk_timer_queue = [];\n"
    "globalThis.__kk_timer_next_id = 1;\n"
    "globalThis.setTimeout = function (fn, _delay, ...args) {\n"
    "  const id = __kk_timer_next_id++;\n"
    "  __kk_timer_queue.push({ id, fn: () => fn(...args) });\n"
    "  return id;\n"
    "};\n"
    "globalThis.setInterval = globalThis.setTimeout;\n"
    "globalThis.clearTimeout = function (id) {\n"
    "  const i = __kk_timer_queue.findIndex(t => t.id === id);\n"
    "  if (i >= 0) __kk_timer_queue.splice(i, 1);\n"
    "};\n"
    "globalThis.clearInterval = globalThis.clearTimeout;\n"
    "globalThis.__kk_flush_timers = function () {\n"
    "  let ran = 0;\n"
    "  while (__kk_timer_queue.length && ran < 1000) {\n"
    "    const t = __kk_timer_queue.shift();\n"
    "    try { t.fn(); } catch (e) {}\n"
    "    ran++;\n"
    "  }\n"
    "  return ran;\n"
    "};\n"
    /* fetch(): the sandbox has no network access of its own (nor should it
     * — see the direct-fetch design elsewhere in this codebase). Calling
     * fetch() here queues the request and returns a pending Promise; the
     * host-side page-load orchestrator polls __kk_next_fetch_request(),
     * performs the real fetch, and settles the Promise via the native
     * qjs_resolve_fetch/qjs_reject_fetch functions (see above) — never by
     * text-embedding the body into eval'd source. */
    "globalThis.__kk_pending_fetches = new Map();\n"
    "globalThis.__kk_fetch_queue = [];\n"
    "globalThis.__kk_fetch_next_id = 1;\n"
    "globalThis.fetch = function (url, options) {\n"
    "  const id = __kk_fetch_next_id++;\n"
    "  const method = (options && options.method) || 'GET';\n"
    "  return new Promise((resolve, reject) => {\n"
    "    __kk_pending_fetches.set(id, { resolve, reject });\n"
    "    __kk_fetch_queue.push({ id, url: String(url), method });\n"
    "  });\n"
    "};\n"
    "globalThis.__kk_next_fetch_request = function () {\n"
    "  return __kk_fetch_queue.shift() || null;\n"
    "};\n"
    "globalThis.__kk_make_response = function (status, bodyText) {\n"
    "  return {\n"
    "    ok: status >= 200 && status < 300,\n"
    "    status,\n"
    "    statusText: '',\n"
    "    headers: new Map(),\n"
    "    text: () => Promise.resolve(bodyText),\n"
    "    json: () => Promise.resolve(JSON.parse(bodyText)),\n"
    "  };\n"
    "};\n"
    "globalThis.__kk_settle_fetch = function (id, response) {\n"
    "  const p = __kk_pending_fetches.get(id);\n"
    "  if (!p) return;\n"
    "  __kk_pending_fetches.delete(id);\n"
    "  p.resolve(response);\n"
    "};\n"
    "globalThis.__kk_settle_fetch_reject = function (id, message) {\n"
    "  const p = __kk_pending_fetches.get(id);\n"
    "  if (!p) return;\n"
    "  __kk_pending_fetches.delete(id);\n"
    "  p.reject(new Error(message));\n"
    "};\n"
    "delete globalThis.__LPWNodeProto;\n";

static void setup_dom_bindings(JSContext *ctx) {
    JS_NewClassID(&g_node_class_id);
    JSClassDef class_def = { "LPWNode", NULL, NULL, NULL, NULL };
    JS_NewClass(JS_GetRuntime(ctx), g_node_class_id, &class_def);

    g_node_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, g_node_proto, node_proto_funcs,
                               sizeof(node_proto_funcs) / sizeof(node_proto_funcs[0]));
    JS_SetClassProto(ctx, g_node_class_id, JS_DupValue(ctx, g_node_proto));

    JSValue global = JS_GetGlobalObject(ctx);

    g_document_obj = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, g_document_obj, document_funcs,
                               sizeof(document_funcs) / sizeof(document_funcs[0]));
    /* Real, but only meaningful during synchronous <script> execution — the
     * page-load orchestrator sets/clears this around each script it runs.
     * Bundlers rely on it heavily (e.g. to resolve their own chunk's URL). */
    JS_SetPropertyStr(ctx, g_document_obj, "currentScript", JS_NULL);
    JS_SetPropertyStr(ctx, global, "document", JS_DupValue(ctx, g_document_obj));

    JS_SetPropertyStr(ctx, global, "__kk_wrap_node", JS_NewCFunction(ctx, js_wrap_node_by_id, "__kk_wrap_node", 1));

    JSValue console_obj = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, console_obj, console_funcs,
                               sizeof(console_funcs) / sizeof(console_funcs[0]));
    JS_SetPropertyStr(ctx, global, "console", console_obj);

    /* Exposed only long enough for the prelude to attach convenience
     * properties to it; the prelude deletes it from globalThis when done. */
    JS_SetPropertyStr(ctx, global, "__LPWNodeProto", JS_DupValue(ctx, g_node_proto));

    JS_FreeValue(ctx, global);

    JSValue prelude_result = JS_Eval(ctx, DOM_PRELUDE, strlen(DOM_PRELUDE), "<dom-prelude>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, prelude_result);
}

/* Runs any Promise reactions / jobs queued by the last eval, and flushes
 * one round of the setTimeout queue. Returns the number of timer
 * callbacks run. Call after each script and once more at the end of a
 * page load, since running timers can itself queue microtasks or more
 * timers. */
int qjs_run_pending_jobs(void) {
    if (!g_rt) return 0;
    JSContext *ctx1;
    int ran_jobs = 0;
    for (;;) {
        int err = JS_ExecutePendingJob(g_rt, &ctx1);
        if (err <= 0) break;
        ran_jobs++;
    }
    static const char flush_code[] = "__kk_flush_timers()";
    JSValue flush = JS_Eval(g_ctx, flush_code, strlen(flush_code), "<flush>", JS_EVAL_TYPE_GLOBAL);
    int32_t ran_timers = 0;
    if (JS_IsException(flush)) {
        JS_FreeValue(g_ctx, JS_GetException(g_ctx));
    } else {
        JS_ToInt32(g_ctx, &ran_timers, flush);
    }
    JS_FreeValue(g_ctx, flush);
    return ran_jobs + ran_timers;
}

static JSValue call_global_fn2(JSContext *ctx, const char *name, JSValueConst a0, JSValueConst a1) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, global, name);
    JSValueConst argv[2] = { a0, a1 };
    JSValue result = JS_Call(ctx, fn, JS_UNDEFINED, 2, argv);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    return result;
}

/* Settles the Promise a sandboxed fetch(url) call returned, using a real
 * host-performed fetch's result. The response body is passed as a proper
 * JS string value (JS_NewStringLen), never text-embedded into eval'd
 * source — safe for arbitrary/binary-ish content, no escaping involved. */
int qjs_resolve_fetch(uint32_t id, uint32_t status, const char *body, uint32_t body_len) {
    if (!g_ctx) return 0;
    JSValue body_str = JS_NewStringLen(g_ctx, body, body_len);
    JSValue status_val = JS_NewInt32(g_ctx, status);
    JSValue resp = call_global_fn2(g_ctx, "__kk_make_response", status_val, body_str);
    JS_FreeValue(g_ctx, body_str);
    JSValue id_val = JS_NewInt32(g_ctx, id);
    JSValue r = call_global_fn2(g_ctx, "__kk_settle_fetch", id_val, resp);
    JS_FreeValue(g_ctx, resp);
    if (JS_IsException(r)) JS_FreeValue(g_ctx, JS_GetException(g_ctx));
    JS_FreeValue(g_ctx, r);
    return 1;
}

int qjs_reject_fetch(uint32_t id, const char *msg, uint32_t msg_len) {
    if (!g_ctx) return 0;
    JSValue msg_str = JS_NewStringLen(g_ctx, msg, msg_len);
    JSValue id_val = JS_NewInt32(g_ctx, id);
    JSValue r = call_global_fn2(g_ctx, "__kk_settle_fetch_reject", id_val, msg_str);
    JS_FreeValue(g_ctx, msg_str);
    if (JS_IsException(r)) JS_FreeValue(g_ctx, JS_GetException(g_ctx));
    JS_FreeValue(g_ctx, r);
    return 1;
}

/* Get type of last eval result: 0=undefined, 1=number, 2=string, 3=bool, 4=null, 5=object, -1=error */
int qjs_last_result_type(void) {
    if (g_error[0] != '\0') return -1;
    if (g_result[0] == '\0') return 0;
    /* Simple heuristic based on content */
    if (memcmp(g_result, "true", 4) == 0 || memcmp(g_result, "false", 5) == 0) return 3;
    if (memcmp(g_result, "null", 4) == 0) return 4;
    if (memcmp(g_result, "undefined", 9) == 0) return 0;
    if (memcmp(g_result, "[object", 7) == 0) return 5;
    /* Check if it looks like a number */
    if (g_result[0] == '-' || (g_result[0] >= '0' && g_result[0] <= '9')) {
        int is_num = 1;
        for (int i = 0; g_result[i]; i++) {
            char c = g_result[i];
            if ((c < '0' || c > '9') && c != '-' && c != '.' && c != 'e' && c != 'E' && c != '+') {
                is_num = 0; break;
            }
        }
        if (is_num) return 1;
    }
    return 2; /* default to string */
}
