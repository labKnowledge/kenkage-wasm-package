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
static JSValue call_global_fn2(JSContext *ctx, const char *name, JSValueConst a0, JSValueConst a1);

/* A Promise that rejects with nothing ever attached to observe it — no
 * .then(_, onRejected), no .catch() — is what a real browser's DevTools
 * flags as "Uncaught (in promise) ...". This engine had no equivalent:
 * QuickJS *does* track this internally (that's what
 * JS_SetHostPromiseRejectionTracker plugs into) but nothing here was ever
 * listening. A rejected dynamic import() — e.g. a lazy-loaded route
 * component whose module throws at the top level, which is exactly what a
 * React.lazy()+Suspense+ErrorBoundary chain reduces to — is precisely this
 * shape: normal control flow from the module system's point of view, so it
 * never hits scriptErrors (not a top-level <script> failure) or
 * __kk_record_uncaught's existing listener/timer coverage, and if the
 * app's own error-boundary reports via Sentry/analytics instead of
 * console.error (typical in production builds), it leaves zero trace in
 * consoleMessages either. That combination made an entire page-load
 * failure completely invisible to every diagnostic this engine had.
 *
 * QuickJS calls this twice per promise: once when it rejects with no
 * handler yet (is_handled=0), and again later if a handler *does* get
 * attached (is_handled=1) — meaning "false alarm". Matching the
 * simplification QuickJS's own reference host (quickjs-libc.c's
 * js_std_promise_rejection_tracker) uses: report immediately on the first
 * call and don't bother suppressing on a later is_handled=1, since a
 * .catch() attached after the fact is rare enough not to be worth the
 * extra bookkeeping. Reuses the existing __kk_uncaught_errors sink rather
 * than adding a new one, so this shows up in loadPage()'s uncaughtErrors
 * exactly like a listener/timer exception already does. */
static void kk_promise_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                          JSValueConst reason, JS_BOOL is_handled,
                                          void *opaque) {
    (void)promise; (void)opaque;
    if (is_handled) return;
    JSValue type = JS_NewString(ctx, "unhandledrejection");
    JSValue result = call_global_fn2(ctx, "__kk_record_uncaught", type, reason);
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, type);
}

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
    /* Runtime-level (not context-level), but re-registering on every reset
     * is harmless — matches g_ctx's lifetime rather than tracking g_rt's
     * separately. */
    JS_SetHostPromiseRejectionTracker(g_rt, kk_promise_rejection_tracker, NULL);
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

    /* A top-level `(async () => { ... })()` (or any expression producing a
     * Promise) completes *synchronously* with the pending Promise itself —
     * same as a real JS host. Callers evaluating one-off snippets almost
     * always want the eventually-settled value instead (what `await` at a
     * REPL prompt gives you), so drain jobs until it settles and unwrap it
     * here, before stringifying. Bounded so a Promise nothing will ever
     * settle (e.g. one still waiting on a fetch() the host hasn't answered)
     * can't hang eval forever — it just falls through and stringifies the
     * still-pending Promise as before. */
    JSPromiseStateEnum promise_state = JS_PromiseState(g_ctx, val);
    if (promise_state != -1) {
        for (int guard = 0; guard < 10000 && promise_state == JS_PROMISE_PENDING; guard++) {
            JSContext *job_ctx;
            int ran = JS_ExecutePendingJob(g_rt, &job_ctx);
            if (ran <= 0) break;
            promise_state = JS_PromiseState(g_ctx, val);
        }
        if (promise_state == JS_PROMISE_FULFILLED || promise_state == JS_PROMISE_REJECTED) {
            JSValue settled = JS_PromiseResult(g_ctx, val);
            JS_FreeValue(g_ctx, val);
            val = settled;
            if (promise_state == JS_PROMISE_REJECTED) {
                /* A rejected top-level Promise is reported the same way a
                 * thrown exception is — that's what `await` would surface. */
                const char *err_str = JS_ToCString(g_ctx, val);
                if (err_str) {
                    int len = (int)strlen(err_str);
                    if (len > (int)sizeof(g_error) - 1) len = (int)sizeof(g_error) - 1;
                    memcpy(g_error, err_str, len);
                    g_error[len] = '\0';
                    JS_FreeCString(g_ctx, err_str);
                }
                JS_FreeValue(g_ctx, val);
                return -1;
            }
        }
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
 *
 * The table grows by doubling (js_realloc) rather than using a fixed-size
 * array: a real-world SPA's reachable import graph routinely runs into the
 * thousands of modules (route-split chunks, their sub-dependencies, shared
 * vendor bundles), so any fixed cap gets silently exceeded on exactly the
 * pages worth testing — qjs_register_module() would previously return -3
 * once full, a return value the JS host wrapper doesn't check, so
 * registration failures were invisible until the *next* page's completely
 * unrelated module lookup mysteriously failed with "not pre-fetched".
 */
static char **g_module_urls = NULL;
static char **g_module_srcs = NULL;
static int g_module_count = 0;
static int g_module_capacity = 0;

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
 * for a repeated url, so re-registering mid-crawl is harmless). Grows the
 * backing table (doubling from an initial 256) rather than capping it —
 * see the comment above g_module_urls for why a fixed cap doesn't hold up
 * against real-world module graphs. */
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
    if (g_module_count >= g_module_capacity) {
        int new_capacity = g_module_capacity > 0 ? g_module_capacity * 2 : 256;
        char **new_urls = js_realloc(g_ctx, g_module_urls, (size_t)new_capacity * sizeof(char *));
        if (!new_urls) return -2;
        g_module_urls = new_urls;
        char **new_srcs = js_realloc(g_ctx, g_module_srcs, (size_t)new_capacity * sizeof(char *));
        if (!new_srcs) return -2;
        g_module_srcs = new_srcs;
        for (int i = g_module_capacity; i < new_capacity; i++) {
            g_module_urls[i] = NULL;
            g_module_srcs[i] = NULL;
        }
        g_module_capacity = new_capacity;
    }
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
extern uint32_t kk_dom_create_comment(const char *text, uint32_t text_len);
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

/* Wrapped node objects have no stable JS identity — every getElementById()/
 * querySelector() call for the same underlying node produces a brand-new
 * wrapper object (confirmed: `document.body === document.body` is false).
 * Anything that needs to key a registry by "which DOM node is this" (a
 * real MutationObserver's target/subtree bookkeeping, for one) can't use
 * the wrapper as a Map key — this exposes the stable underlying node id
 * instead, for exactly that purpose. */
static JSValue node_get_internal_id(JSContext *ctx, JSValueConst this_val) {
    return JS_NewInt32(ctx, (int32_t)node_id_of(this_val));
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
    JS_CGETSET_DEF("__kk_internal_id", node_get_internal_id, NULL),
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

/* Was missing entirely (not even a no-op — calling it threw a real,
 * engine-level "not a function" TypeError). React's DOM host config uses
 * comment nodes as structural markers when mounting Suspense boundaries
 * (`<!--$-->`...`<!--/$-->`) — this app uses React.lazy()+Suspense
 * throughout its route tree. That throw happens inside React's own
 * reconciler/commit-phase code, which has its own internal try/catch for
 * exactly this kind of failure — so it never reaches an app-level error
 * boundary, console.error, or (being an engine-level throw rather than an
 * explicit `new TypeError(...)`) even a hook on the global TypeError
 * constructor. The net effect: React silently abandons that commit with
 * zero signal on any diagnostic surface this engine has, which is
 * indistinguishable from "nothing to render" from the outside. */
static JSValue doc_createComment(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    size_t len;
    const char *text = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!text) return JS_NULL;
    uint32_t id = kk_dom_create_comment(text, (uint32_t)len);
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
    JS_CFUNC_DEF("createComment", 1, doc_createComment),
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
    /* Missing entirely before — legacy React (16/17, still very common in
     * deployed apps) walks `container.ownerDocument`/`.defaultView` while
     * mounting a root to attach its delegated event listeners; without
     * this the mount call itself throws deep inside React (reading a
     * property off the `undefined` that `.ownerDocument` resolved to) and
     * the whole app — including every effect/fetch it would ever run —
     * never starts. */
    "Object.defineProperty(__LPWNodeProto, 'ownerDocument', {\n"
    "  get() { return document; },\n"
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
    /* Every real element this engine hands out shares one generic LPWNode
     * class regardless of tag name, so none of these can ever be true via
     * `instanceof` for an actual node — a `<input>` and a `<div>` are
     * indistinguishable at this layer. What *was* actively broken though:
     * these globals didn't exist AT ALL, and real bundles (react-dom's
     * controlled-input sync, focus-management/a11y utilities, and plenty
     * of others) routinely do `el instanceof HTMLInputElement` or similar
     * — QuickJS's `instanceof` throws a hard, uncatchable-by-the-script
     * "invalid instanceof right operand" the instant its right side is
     * `undefined`, taking out whatever function ran the check (see the
     * `t instanceof e.HTMLIFrameElement` focus-check that motivated this).
     * Existing-but-always-false is a strictly safer default than throwing.
     */
    "(function () {\n"
    "  const names = [\n"
    "    'HTMLAnchorElement', 'HTMLAreaElement', 'HTMLAudioElement', 'HTMLBaseElement', 'HTMLBodyElement',\n"
    "    'HTMLBRElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'HTMLDataElement', 'HTMLDataListElement',\n"
    "    'HTMLDetailsElement', 'HTMLDialogElement', 'HTMLDivElement', 'HTMLDListElement', 'HTMLEmbedElement',\n"
    "    'HTMLFieldSetElement', 'HTMLFormElement', 'HTMLHeadElement', 'HTMLHeadingElement', 'HTMLHRElement',\n"
    "    'HTMLHtmlElement', 'HTMLIFrameElement', 'HTMLImageElement', 'HTMLInputElement', 'HTMLLabelElement',\n"
    "    'HTMLLegendElement', 'HTMLLIElement', 'HTMLLinkElement', 'HTMLMapElement', 'HTMLMetaElement',\n"
    "    'HTMLMeterElement', 'HTMLModElement', 'HTMLObjectElement', 'HTMLOListElement', 'HTMLOptGroupElement',\n"
    "    'HTMLOptionElement', 'HTMLOutputElement', 'HTMLParagraphElement', 'HTMLParamElement', 'HTMLPictureElement',\n"
    "    'HTMLPreElement', 'HTMLProgressElement', 'HTMLQuoteElement', 'HTMLScriptElement', 'HTMLSelectElement',\n"
    "    'HTMLSlotElement', 'HTMLSourceElement', 'HTMLSpanElement', 'HTMLStyleElement', 'HTMLTableElement',\n"
    "    'HTMLTableCellElement', 'HTMLTableColElement', 'HTMLTableRowElement', 'HTMLTableSectionElement',\n"
    "    'HTMLTemplateElement', 'HTMLTextAreaElement', 'HTMLTimeElement', 'HTMLTitleElement', 'HTMLTrackElement',\n"
    "    'HTMLUListElement', 'HTMLUnknownElement', 'HTMLVideoElement', 'SVGElement',\n"
    "  ];\n"
    "  for (const name of names) {\n"
    "    globalThis[name] = ({ [name]: class extends HTMLElement {} })[name];\n"
    "  }\n"
    "})();\n"
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
    /* Was missing entirely (reads back undefined) — feature-flag SDKs and
     * analytics libraries very commonly defer their first fetch until the
     * tab is confirmed foregrounded, checking `document.visibilityState
     * === 'visible'` specifically (a strict string comparison, not just a
     * truthiness check) rather than only listening for `visibilitychange`
     * later. `undefined === 'visible'` is always false, so that check
     * would never pass and the deferred initialization — which real-world
     * code frequently gates an entire feature's first network call behind
     * — would never run, with nothing to observe since it's just a
     * conditional quietly not taking its branch, not a thrown error.
     * Matches this engine's already-established default of "assume a
     * normal, active foreground tab" (see IntersectionObserver/
     * ResizeObserver above) rather than leaving it unset. */
    "document.hidden = false;\n"
    "document.visibilityState = 'visible';\n"
    /* Also entirely missing before (reads back undefined). Framework
     * bootstraps very commonly branch on this exact value before deciding
     * whether to run immediately or wait for DOMContentLoaded/load — e.g.
     * `if (document.readyState === 'complete') init(); else
     * window.addEventListener('load', init);`. loadPage() only reaches
     * script execution after the whole document is already parsed, and by
     * the time it dispatches DOMContentLoaded/load at the end every
     * script has already run — 'complete' matches that timeline better
     * than 'loading'/'interactive' would for the entire span scripts
     * actually execute in. */
    "document.readyState = 'complete';\n"
    "__LPWNodeProto.getElementsByTagName = function (tag) { return this.querySelectorAll(tag); };\n"
    /* Was missing entirely (not even a no-op) — some virtualized-list
     * libraries call this directly instead of only going through
     * ResizeObserver to size their container. Matches ResizeObserver's
     * synthetic rect below so both paths agree on "a normal-sized,
     * visible viewport" rather than one reporting a size and the other
     * throwing "not a function". */
    "__LPWNodeProto.getBoundingClientRect = function () {\n"
    "  return { x: 0, y: 0, width: 1280, height: 800, top: 0, left: 0, right: 1280, bottom: 800 };\n"
    "};\n"
    /* MutationObserver was a pure no-op below this point ('observe()'d
     * callbacks simply never fire') — wired up for real here instead,
     * covering the common mutation paths (childList via appendChild/
     * insertBefore/removeChild, attributes via setAttribute/
     * removeAttribute). Registered by the underlying node's stable
     * __kk_internal_id rather than the wrapper object itself, since wrapper
     * objects have no stable identity (two getElementById() calls for the
     * same element return unequal objects) — a plain object/Map keyed on
     * the wrapper would silently never match on the next lookup. Batches
     * records per observer and delivers via queueMicrotask, matching the
     * spec's asynchronous delivery timing (multiple synchronous mutations
     * in the same turn arrive as one callback invocation, not one per
     * mutation). Known gap: node.remove()/textContent/innerHTML setters
     * mutate through different native paths not wrapped here, so those
     * won't be observed — a pragmatic subset covering what real code
     * calling appendChild/insertBefore/removeChild/setAttribute directly
     * needs, not full coverage of every mutation path. */
    "globalThis.__kk_mutation_registry = new Map();\n"
    "globalThis.__kk_notify_mutation = function (targetNode, records) {\n"
    "  if (!targetNode || typeof targetNode.__kk_internal_id !== 'number') return;\n"
    "  let node = targetNode;\n"
    "  let isTarget = true;\n"
    "  while (node) {\n"
    "    const regs = __kk_mutation_registry.get(node.__kk_internal_id);\n"
    "    if (regs) {\n"
    "      for (const reg of regs) {\n"
    "        if (isTarget || reg.options.subtree) {\n"
    "          reg.observer.__kk_pending.push(...records);\n"
    "          reg.observer.__kk_schedule();\n"
    "        }\n"
    "      }\n"
    "    }\n"
    "    node = node.parentNode;\n"
    "    isTarget = false;\n"
    "  }\n"
    "};\n"
    "(function () {\n"
    "  const nativeAppendChild = __LPWNodeProto.appendChild;\n"
    "  __LPWNodeProto.appendChild = function (child) {\n"
    "    const result = nativeAppendChild.call(this, child);\n"
    "    __kk_notify_mutation(this, [{ type: 'childList', target: this, addedNodes: [child], removedNodes: [] }]);\n"
    "    return result;\n"
    "  };\n"
    "  const nativeInsertBefore = __LPWNodeProto.insertBefore;\n"
    "  __LPWNodeProto.insertBefore = function (child, ref) {\n"
    "    const result = nativeInsertBefore.call(this, child, ref);\n"
    "    __kk_notify_mutation(this, [{ type: 'childList', target: this, addedNodes: [child], removedNodes: [] }]);\n"
    "    return result;\n"
    "  };\n"
    "  const nativeRemoveChild = __LPWNodeProto.removeChild;\n"
    "  __LPWNodeProto.removeChild = function (child) {\n"
    "    const result = nativeRemoveChild.call(this, child);\n"
    "    __kk_notify_mutation(this, [{ type: 'childList', target: this, addedNodes: [], removedNodes: [child] }]);\n"
    "    return result;\n"
    "  };\n"
    "  const nativeSetAttribute = __LPWNodeProto.setAttribute;\n"
    "  __LPWNodeProto.setAttribute = function (name, value) {\n"
    "    const result = nativeSetAttribute.call(this, name, value);\n"
    "    __kk_notify_mutation(this, [{ type: 'attributes', target: this, attributeName: String(name) }]);\n"
    "    return result;\n"
    "  };\n"
    "  const nativeRemoveAttribute = __LPWNodeProto.removeAttribute;\n"
    "  __LPWNodeProto.removeAttribute = function (name) {\n"
    "    const result = nativeRemoveAttribute.call(this, name);\n"
    "    __kk_notify_mutation(this, [{ type: 'attributes', target: this, attributeName: String(name) }]);\n"
    "    return result;\n"
    "  };\n"
    "})();\n"
    /* Was missing entirely — `.dataset` (DOMStringMap) is the standard way
     * real apps read their own `data-*` attributes, and server-rendered
     * frameworks that hydrate client-side (Inertia.js among them) commonly
     * bootstrap by reading a `data-page`-style attribute this way to learn
     * which component to mount and with what props. Without this, element
     * `.dataset` reads back `undefined`, and code that only null-checks the
     * *element* before indexing into `.dataset` (`el?.dataset.page`, where
     * the `?.` guards `el` but not `.dataset`) throws immediately — the
     * entire hydration step, and everything downstream of it, never runs,
     * with nothing but a rejected Promise to show for it (see
     * kk_promise_rejection_tracker above for why that alone stayed
     * invisible). Implemented as a Proxy over the existing
     * getAttribute/setAttribute/hasAttribute bindings (kebab-case <->
     * camelCase per the DOMStringMap spec) rather than a new native
     * binding — no engine-level attribute-enumeration capability exists to
     * back a snapshot object, and a live Proxy is actually more spec-
     * faithful for the read path real code exercises. */
    "__LPWNodeProto.__kk_dataset_key_to_attr = function (prop) {\n"
    "  return 'data-' + String(prop).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());\n"
    "};\n"
    "Object.defineProperty(__LPWNodeProto, 'dataset', {\n"
    "  configurable: true,\n"
    "  get() {\n"
    "    const el = this;\n"
    "    return new Proxy({}, {\n"
    "      get(_, prop) {\n"
    "        if (typeof prop !== 'string') return undefined;\n"
    "        const val = el.getAttribute(el.__kk_dataset_key_to_attr(prop));\n"
    "        return val === null ? undefined : val;\n"
    "      },\n"
    "      set(_, prop, value) {\n"
    "        el.setAttribute(el.__kk_dataset_key_to_attr(prop), String(value));\n"
    "        return true;\n"
    "      },\n"
    "      has(_, prop) {\n"
    "        return typeof prop === 'string' && el.hasAttribute(el.__kk_dataset_key_to_attr(prop));\n"
    "      },\n"
    "      deleteProperty(_, prop) {\n"
    "        if (typeof prop === 'string') el.removeAttribute(el.__kk_dataset_key_to_attr(prop));\n"
    "        return true;\n"
    "      },\n"
    "    });\n"
    "  },\n"
    "});\n"
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
    /* Real frameworks' event-plugin/scheduler internals routinely do
     * `nativeEvent instanceof MouseEvent` (or KeyboardEvent, etc.) for type
     * dispatch — with only the base Event/CustomEvent existing, that threw
     * a hard "invalid instanceof right operand" the moment any such check
     * ran, well downstream of (and much harder to trace back to) the
     * missing global than a plain ReferenceError would have been. There's
     * no real input/UI system generating genuine instances of these here;
     * they exist purely so `instanceof`, feature-detection, and manual
     * `new MouseEvent(...)` construction all work without throwing. */
    "globalThis.UIEvent = class UIEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); this.view = (init && init.view) ?? null; this.detail = (init && init.detail) ?? 0; }\n"
    "};\n"
    "globalThis.MouseEvent = class MouseEvent extends UIEvent {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.screenX = i.screenX ?? 0; this.screenY = i.screenY ?? 0;\n"
    "    this.clientX = i.clientX ?? 0; this.clientY = i.clientY ?? 0;\n"
    "    this.pageX = i.pageX ?? 0; this.pageY = i.pageY ?? 0;\n"
    "    this.button = i.button ?? 0; this.buttons = i.buttons ?? 0;\n"
    "    this.ctrlKey = !!i.ctrlKey; this.shiftKey = !!i.shiftKey; this.altKey = !!i.altKey; this.metaKey = !!i.metaKey;\n"
    "    this.relatedTarget = i.relatedTarget ?? null;\n"
    "  }\n"
    "};\n"
    "globalThis.PointerEvent = class PointerEvent extends MouseEvent {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.pointerId = i.pointerId ?? 0; this.pointerType = i.pointerType ?? ''; this.isPrimary = !!i.isPrimary;\n"
    "    this.width = i.width ?? 1; this.height = i.height ?? 1; this.pressure = i.pressure ?? 0;\n"
    "  }\n"
    "};\n"
    "globalThis.KeyboardEvent = class KeyboardEvent extends UIEvent {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.key = i.key ?? ''; this.code = i.code ?? ''; this.keyCode = i.keyCode ?? 0; this.which = i.which ?? i.keyCode ?? 0;\n"
    "    this.ctrlKey = !!i.ctrlKey; this.shiftKey = !!i.shiftKey; this.altKey = !!i.altKey; this.metaKey = !!i.metaKey;\n"
    "    this.repeat = !!i.repeat; this.isComposing = !!i.isComposing;\n"
    "  }\n"
    "};\n"
    "globalThis.FocusEvent = class FocusEvent extends UIEvent {\n"
    "  constructor(type, init) { super(type, init); this.relatedTarget = (init && init.relatedTarget) ?? null; }\n"
    "};\n"
    "globalThis.InputEvent = class InputEvent extends UIEvent {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.data = i.data ?? null; this.inputType = i.inputType ?? ''; this.isComposing = !!i.isComposing;\n"
    "  }\n"
    "};\n"
    "globalThis.CompositionEvent = class CompositionEvent extends UIEvent {\n"
    "  constructor(type, init) { super(type, init); this.data = (init && init.data) ?? ''; }\n"
    "};\n"
    "globalThis.WheelEvent = class WheelEvent extends MouseEvent {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.deltaX = i.deltaX ?? 0; this.deltaY = i.deltaY ?? 0; this.deltaZ = i.deltaZ ?? 0; this.deltaMode = i.deltaMode ?? 0;\n"
    "  }\n"
    "};\n"
    "globalThis.TouchEvent = class TouchEvent extends UIEvent {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.touches = i.touches ?? []; this.targetTouches = i.targetTouches ?? []; this.changedTouches = i.changedTouches ?? [];\n"
    "    this.ctrlKey = !!i.ctrlKey; this.shiftKey = !!i.shiftKey; this.altKey = !!i.altKey; this.metaKey = !!i.metaKey;\n"
    "  }\n"
    "};\n"
    "globalThis.AnimationEvent = class AnimationEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); const i = init || {}; this.animationName = i.animationName ?? ''; this.elapsedTime = i.elapsedTime ?? 0; this.pseudoElement = i.pseudoElement ?? ''; }\n"
    "};\n"
    "globalThis.TransitionEvent = class TransitionEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); const i = init || {}; this.propertyName = i.propertyName ?? ''; this.elapsedTime = i.elapsedTime ?? 0; this.pseudoElement = i.pseudoElement ?? ''; }\n"
    "};\n"
    "globalThis.ClipboardEvent = class ClipboardEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); this.clipboardData = (init && init.clipboardData) ?? null; }\n"
    "};\n"
    "globalThis.DragEvent = class DragEvent extends MouseEvent {\n"
    "  constructor(type, init) { super(type, init); this.dataTransfer = (init && init.dataTransfer) ?? null; }\n"
    "};\n"
    "globalThis.ProgressEvent = class ProgressEvent extends Event {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.lengthComputable = !!i.lengthComputable; this.loaded = i.loaded ?? 0; this.total = i.total ?? 0;\n"
    "  }\n"
    "};\n"
    "globalThis.ErrorEvent = class ErrorEvent extends Event {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.message = i.message ?? ''; this.filename = i.filename ?? ''; this.lineno = i.lineno ?? 0; this.colno = i.colno ?? 0; this.error = i.error ?? null;\n"
    "  }\n"
    "};\n"
    "globalThis.MessageEvent = class MessageEvent extends Event {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.data = i.data ?? null; this.origin = i.origin ?? ''; this.lastEventId = i.lastEventId ?? ''; this.source = i.source ?? null; this.ports = i.ports ?? [];\n"
    "  }\n"
    "};\n"
    "globalThis.PromiseRejectionEvent = class PromiseRejectionEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); this.promise = (init && init.promise) ?? null; this.reason = (init && init.reason) ?? undefined; }\n"
    "};\n"
    "globalThis.PopStateEvent = class PopStateEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); this.state = (init && init.state) ?? null; }\n"
    "};\n"
    "globalThis.HashChangeEvent = class HashChangeEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); const i = init || {}; this.oldURL = i.oldURL ?? ''; this.newURL = i.newURL ?? ''; }\n"
    "};\n"
    "globalThis.StorageEvent = class StorageEvent extends Event {\n"
    "  constructor(type, init) {\n"
    "    super(type, init);\n"
    "    const i = init || {};\n"
    "    this.key = i.key ?? null; this.oldValue = i.oldValue ?? null; this.newValue = i.newValue ?? null; this.url = i.url ?? ''; this.storageArea = i.storageArea ?? null;\n"
    "  }\n"
    "};\n"
    "globalThis.SubmitEvent = class SubmitEvent extends Event {\n"
    "  constructor(type, init) { super(type, init); this.submitter = (init && init.submitter) ?? null; }\n"
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
    "  if (l) for (const fn of l.slice()) { try { fn.call(this, ev); } catch (e) { __kk_record_uncaught(ev.type, e); } }\n"
    "  return true;\n"
    "};\n"
    "document.defaultView = globalThis;\n"
    "document.ownerDocument = null;\n"
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
    /* Uncaught-error sink: real browsers never let a timer callback's or an
     * event listener's exception propagate to whoever scheduled/dispatched
     * it — it becomes a `window.onerror`/console report instead. Silently
     * discarding it entirely (the previous behavior) is what made a huge
     * class of real-world scripts fail invisibly: an app's boot sequence
     * commonly runs inside a `load` listener or a scheduler callback, and if
     * anything in that chain threw (e.g. touching a not-yet-implemented
     * global), the exception vanished with zero signal — no scriptError,
     * nothing — so downstream code (very often the actual data-fetching
     * calls a page makes after mount) silently never ran. Recording these
     * here lets the host (see __kk_drain_uncaught_errors) surface them into
     * loadPage()'s result instead. */
    "globalThis.__kk_uncaught_errors = [];\n"
    "globalThis.__kk_record_uncaught = function (type, e) {\n"
    "  const message = (e && e.message) ? String(e.message) : String(e);\n"
    "  const stack = (e && e.stack) ? String(e.stack) : undefined;\n"
    "  __kk_uncaught_errors.push({ type: String(type), message, stack });\n"
    "};\n"
    "globalThis.__kk_drain_uncaught_errors = function () {\n"
    "  const out = __kk_uncaught_errors;\n"
    "  __kk_uncaught_errors = [];\n"
    "  return out;\n"
    "};\n"
    /* console.log/warn/error/info are native no-ops (see console_log in the
     * C bindings above) — real pages, and React in particular, lean on
     * console.error to report caught render/lifecycle errors (error
     * boundaries, failed effects, prop-type warnings) that never throw far
     * enough to hit __kk_record_uncaught above. Discarding them meant a
     * page could fail entirely client-side with zero signal anywhere in
     * loadPage()'s result. Wrapping them here (rather than changing the
     * native functions) keeps the C fallback harmless while giving the host
     * an actual transcript via __kk_drain_console_messages. */
    "globalThis.__kk_console_messages = [];\n"
    "(function () {\n"
    "  const stringify = (a) => {\n"
    "    if (typeof a === 'string') return a;\n"
    "    if (a instanceof Error) return a.stack || a.message || String(a);\n"
    "    try { return JSON.stringify(a); } catch (e) { return String(a); }\n"
    "  };\n"
    "  for (const level of ['log', 'warn', 'error', 'info']) {\n"
    "    console[level] = function (...args) {\n"
    "      __kk_console_messages.push({ level, message: args.map(stringify).join(' ') });\n"
    "    };\n"
    "  }\n"
    "})();\n"
    "globalThis.__kk_drain_console_messages = function () {\n"
    "  const out = __kk_console_messages;\n"
    "  __kk_console_messages = [];\n"
    "  return out;\n"
    "};\n"
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
    "    try { t.fn(); } catch (e) { __kk_record_uncaught('timer', e); }\n"
    "    ran++;\n"
    "  }\n"
    "  return ran;\n"
    "};\n"
    "globalThis.queueMicrotask = function (fn) {\n"
    "  Promise.resolve().then(fn).catch(e => __kk_record_uncaught('queueMicrotask', e));\n"
    "};\n"
    "globalThis.requestAnimationFrame = function (fn) { return globalThis.setTimeout(() => fn(Date.now()), 16); };\n"
    "globalThis.cancelAnimationFrame = globalThis.clearTimeout;\n"
    "globalThis.requestIdleCallback = function (fn) {\n"
    "  return globalThis.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1);\n"
    "};\n"
    "globalThis.cancelIdleCallback = globalThis.clearTimeout;\n"
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
    /* Resolves against the page's own location, same as a real browser's
     * fetch() — most real-world call sites pass a relative path
     * ('/api/...', './x.json'), not an absolute URL. Previously this
     * queued the raw string as-is: the host-side fetchFn either received a
     * bare path it couldn't do anything useful with, or (with a real
     * fetch()) threw on the invalid-URL input — either way rejecting the
     * Promise with nothing downstream to observe it, so the failure never
     * surfaced anywhere. location only reflects a real URL once loadPage()
     * seeds it (see index.ts); a plain eval() caller with no navigation
     * context falls back to using the possibly-relative string untouched. */
    "globalThis.fetch = function (url, options) {\n"
    "  const id = __kk_fetch_next_id++;\n"
    "  const method = (options && options.method) || 'GET';\n"
    "  let resolvedUrl;\n"
    "  try {\n"
    "    resolvedUrl = (globalThis.location && globalThis.location.href !== 'about:blank')\n"
    "      ? new URL(String(url), globalThis.location.href).href\n"
    "      : String(url);\n"
    "  } catch (e) { resolvedUrl = String(url); }\n"
    "  return new Promise((resolve, reject) => {\n"
    "    __kk_pending_fetches.set(id, { resolve, reject });\n"
    "    __kk_fetch_queue.push({ id, url: resolvedUrl, method });\n"
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
    /* Genuinely dynamic import() support: crawlModuleGraph (host side) can
     * only pre-fetch specifiers it can see as literal text — a computed
     * specifier (`import(\`./pages/${name}.js\`)`) or a chunk imported for
     * the first time only after loadPage() has already returned (e.g. a
     * click handler firing later) is invisible to it no matter how
     * thoroughly it crawls. JS syntax gives no way to intercept the native
     * `import()` expression itself (it's a keyword, not a patchable
     * function), so the host rewrites `import(x)` call sites in fetched
     * source into `__kk_dynamic_import(x, moduleUrl)` before registering
     * them (see rewriteDynamicImports in index.ts) — the same
     * source-transform technique Babel's dynamic-import plugin and
     * SystemJS use, since neither can intercept the keyword either.
     *
     * This queues the request exactly like fetch() above and returns a
     * pending Promise. The host peeks it, fetches the target module's
     * bytes, registers it (and crawls *its* statically-visible
     * dependencies via the existing machinery), and only then evaluates a
     * real `await import(url)` from inside the sandbox to actually settle
     * this promise — deliberately not hand-rolling module linking/
     * evaluation or trying to marshal a namespace object across the
     * WASM boundary as a string. The registered module is now sitting in
     * the same pre-fetch table crawlModuleGraph populates, so that real
     * import() resolves synchronously through the exact mechanism that
     * already works for eagerly-discovered specifiers. */
    "globalThis.__kk_pending_module_requests = new Map();\n"
    "globalThis.__kk_module_request_queue = [];\n"
    "globalThis.__kk_module_request_next_id = 1;\n"
    "globalThis.__kk_dynamic_import = function (specifier, baseUrl) {\n"
    "  const id = __kk_module_request_next_id++;\n"
    // Ad-hoc eval() calls (as opposed to a specific <script>/module being
    // rewritten with its own known URL) have no moduleUrl to bake in at
    // rewrite time, so they pass `undefined` here — fall back to the
    // page's current location, same as fetch() above does for the same
    // reason (a plain eval() with no navigation context has neither and
    // ends up trying the possibly-relative string untouched).
    "  const base = baseUrl || (globalThis.location && globalThis.location.href !== 'about:blank' ? globalThis.location.href : undefined);\n"
    "  let resolvedUrl;\n"
    "  try { resolvedUrl = new URL(String(specifier), base).href; }\n"
    "  catch (e) { resolvedUrl = String(specifier); }\n"
    "  return new Promise((resolve, reject) => {\n"
    "    __kk_pending_module_requests.set(id, { resolve, reject });\n"
    "    __kk_module_request_queue.push({ id, url: resolvedUrl });\n"
    "  });\n"
    "};\n"
    "globalThis.__kk_next_module_request = function () {\n"
    "  return __kk_module_request_queue.shift() || null;\n"
    "};\n"
    /* Vanilla QuickJS (unlike quickjs-ng or a real browser) never links ICU
     * and has no `Intl` global at all — any script that references it
     * (feature-detection like `typeof Intl`, or an outright `new
     * Intl.NumberFormat(...)` call, both common in analytics/maps/i18n
     * snippets) hits a bare ReferenceError before it can do anything else.
     * This is a pragmatic, locale-oblivious subset (always formats as if
     * locale were 'en-US', no real ICU number/date/plural rules) — same
     * spirit as the URL/URLSearchParams polyfills above: enough surface
     * that real-world scripts stop crashing on first touch, not a spec-
     * faithful implementation. */
    "globalThis.Intl = {\n"
    "  NumberFormat: class NumberFormat {\n"
    "    constructor(locale, options) { this.options = options || {}; }\n"
    "    format(value) {\n"
    "      const n = Number(value);\n"
    "      const opts = this.options;\n"
    "      if (opts.style === 'percent') {\n"
    "        return (n * 100).toFixed(opts.maximumFractionDigits ?? 0) + '%';\n"
    "      }\n"
    "      const defaultDigits = opts.style === 'currency' ? 2 : (Number.isInteger(n) ? 0 : 3);\n"
    "      let digits = n.toFixed(opts.maximumFractionDigits ?? defaultDigits);\n"
    "      let [intPart, fracPart] = digits.split('.');\n"
    "      if (opts.useGrouping !== false) {\n"
    "        intPart = intPart.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');\n"
    "      }\n"
    "      let out = fracPart ? intPart + '.' + fracPart : intPart;\n"
    "      if (opts.style === 'currency') {\n"
    "        out = (opts.currencyDisplay === 'code' ? (opts.currency || 'USD') + ' ' : '$') + out;\n"
    "      }\n"
    "      return out;\n"
    "    }\n"
    "    resolvedOptions() { return Object.assign({ locale: 'en-US', numberingSystem: 'latn' }, this.options); }\n"
    "  },\n"
    "  DateTimeFormat: class DateTimeFormat {\n"
    "    constructor(locale, options) { this.options = options || {}; }\n"
    "    format(date) {\n"
    "      const d = date instanceof Date ? date : new Date(date);\n"
    "      return d.toString();\n"
    "    }\n"
    "    resolvedOptions() { return Object.assign({ locale: 'en-US', timeZone: 'UTC' }, this.options); }\n"
    "  },\n"
    "  Collator: class Collator {\n"
    "    constructor(locale, options) { this.options = options || {}; }\n"
    "    compare(a, b) { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; }\n"
    "  },\n"
    "  PluralRules: class PluralRules {\n"
    "    constructor(locale, options) { this.options = options || {}; }\n"
    "    select(n) { return n === 1 ? 'one' : 'other'; }\n"
    "  },\n"
    "  ListFormat: class ListFormat {\n"
    "    constructor(locale, options) { this.options = options || {}; }\n"
    "    format(list) { return Array.from(list).join(', '); }\n"
    "  },\n"
    "  getCanonicalLocales(locales) {\n"
    "    return locales === undefined ? [] : Array.isArray(locales) ? locales.slice() : [String(locales)];\n"
    "  },\n"
    "};\n"
    /* The rest of this prelude is a batch of pragmatic, non-throwing stubs
     * for standard globals that real-world app bundles very commonly touch
     * somewhere in their boot/render/hydrate path (feature detection or
     * direct use) — analytics snippets, routers, UI frameworks, bundler
     * runtime helpers. None of these existed before; a bare reference to
     * any one of them threw a ReferenceError that (per the __kk_record_uncaught
     * fix above) is now at least visible, but the goal here is to avoid the
     * throw in the first place so the *rest* of a script's boot logic (most
     * importantly, whatever fetch() calls it was about to make) still runs.
     * None of these claim spec fidelity — same "close enough that real
     * scripts stop crashing on first touch" spirit as URL/Intl above. */
    "globalThis.localStorage = (function () {\n"
    "  const store = new Map();\n"
    "  return {\n"
    "    getItem: (k) => store.has(String(k)) ? store.get(String(k)) : null,\n"
    "    setItem: (k, v) => { store.set(String(k), String(v)); },\n"
    "    removeItem: (k) => { store.delete(String(k)); },\n"
    "    clear: () => { store.clear(); },\n"
    "    key: (i) => [...store.keys()][i] ?? null,\n"
    "    get length() { return store.size; },\n"
    "  };\n"
    "})();\n"
    "globalThis.sessionStorage = globalThis.localStorage;\n"
    /* Real IntersectionObserver/ResizeObserver gate a huge amount of
     * real-world lazy-loading and deferred data-fetching (images, infinite
     * scroll, analytics impression tracking). There's no real viewport or
     * layout in this engine, so the most useful pragmatic behavior — the one
     * that actually unblocks the "fetch after load" scripts this is meant to
     * fix — is to report every observed target as immediately visible/sized,
     * rather than a dead no-op that would leave observers waiting forever. */
    "globalThis.IntersectionObserver = class IntersectionObserver {\n"
    "  constructor(callback, options) { this.callback = callback; this.options = options || {}; this.targets = new Set(); }\n"
    "  observe(target) {\n"
    "    this.targets.add(target);\n"
    "    queueMicrotask(() => {\n"
    "      if (!this.targets.has(target)) return;\n"
    "      this.callback([{ target, isIntersecting: true, intersectionRatio: 1, boundingClientRect: {}, intersectionRect: {}, rootBounds: null, time: Date.now() }], this);\n"
    "    });\n"
    "  }\n"
    "  unobserve(target) { this.targets.delete(target); }\n"
    "  disconnect() { this.targets.clear(); }\n"
    "  takeRecords() { return []; }\n"
    "};\n"
    /* A reported 0x0 size (the previous behavior) reads as "this element
     * has no space" to any consumer — and the overwhelmingly common
     * consumer of ResizeObserver in real apps is a virtualized/windowed
     * list (react-window, @tanstack/react-virtual, etc.) computing how
     * many rows fit its container. Zero space means zero visible rows,
     * and since these libraries typically only fetch the data for rows
     * they're about to render, that silently starves the very
     * data-fetching this engine exists to observe — a page can look
     * completely empty with no error anywhere. Reporting a plausible
     * desktop-viewport-sized rect instead (matching the spirit of
     * IntersectionObserver's "assume visible" above) lets these
     * virtualizers compute a normal, non-empty visible range. */
    "globalThis.ResizeObserver = class ResizeObserver {\n"
    "  constructor(callback) { this.callback = callback; this.targets = new Set(); }\n"
    "  observe(target) {\n"
    "    this.targets.add(target);\n"
    "    queueMicrotask(() => {\n"
    "      if (!this.targets.has(target)) return;\n"
    "      const width = 1280, height = 800;\n"
    "      const rect = { width, height, top: 0, left: 0, right: width, bottom: height };\n"
    "      this.callback([{ target, contentRect: rect, borderBoxSize: [{ inlineSize: width, blockSize: height }], contentBoxSize: [{ inlineSize: width, blockSize: height }] }], this);\n"
    "    });\n"
    "  }\n"
    "  unobserve(target) { this.targets.delete(target); }\n"
    "  disconnect() { this.targets.clear(); }\n"
    "};\n"
    /* Real implementation — see __kk_notify_mutation/__kk_mutation_registry
     * and the appendChild/insertBefore/removeChild/setAttribute/
     * removeAttribute wrapping above, which is what actually feeds this. */
    "globalThis.MutationObserver = class MutationObserver {\n"
    "  constructor(callback) {\n"
    "    this.callback = callback;\n"
    "    this.__kk_pending = [];\n"
    "    this.__kk_scheduled = false;\n"
    "    this.__kk_targets = [];\n"
    "  }\n"
    "  __kk_schedule() {\n"
    "    if (this.__kk_scheduled) return;\n"
    "    this.__kk_scheduled = true;\n"
    "    queueMicrotask(() => {\n"
    "      this.__kk_scheduled = false;\n"
    "      const records = this.__kk_pending;\n"
    "      this.__kk_pending = [];\n"
    "      if (records.length) this.callback(records, this);\n"
    "    });\n"
    "  }\n"
    "  observe(target, options) {\n"
    "    if (!target || typeof target.__kk_internal_id !== 'number') return;\n"
    "    const id = target.__kk_internal_id;\n"
    "    let regs = __kk_mutation_registry.get(id);\n"
    "    if (!regs) { regs = new Set(); __kk_mutation_registry.set(id, regs); }\n"
    "    const reg = { observer: this, options: options || {} };\n"
    "    regs.add(reg);\n"
    "    this.__kk_targets.push({ id, reg });\n"
    "  }\n"
    "  disconnect() {\n"
    "    for (const { id, reg } of this.__kk_targets) {\n"
    "      const regs = __kk_mutation_registry.get(id);\n"
    "      if (!regs) continue;\n"
    "      regs.delete(reg);\n"
    "      if (regs.size === 0) __kk_mutation_registry.delete(id);\n"
    "    }\n"
    "    this.__kk_targets = [];\n"
    "    this.__kk_pending = [];\n"
    "  }\n"
    "  takeRecords() {\n"
    "    const r = this.__kk_pending;\n"
    "    this.__kk_pending = [];\n"
    "    return r;\n"
    "  }\n"
    "};\n"
    "globalThis.matchMedia = function (query) {\n"
    "  return {\n"
    "    matches: false,\n"
    "    media: String(query),\n"
    "    onchange: null,\n"
    "    addListener() {},\n"
    "    removeListener() {},\n"
    "    addEventListener() {},\n"
    "    removeEventListener() {},\n"
    "    dispatchEvent() { return true; },\n"
    "  };\n"
    "};\n"
    "globalThis.getComputedStyle = function (el) {\n"
    "  return new Proxy({}, {\n"
    "    get: (t, k) => k === 'getPropertyValue' ? (() => '') : (t[k] ?? ''),\n"
    "    has: () => true,\n"
    "  });\n"
    "};\n"
    /* Non-cryptographic — Math.random()-backed. Fine for code paths that
     * just want *a* random value/UUID (IDs, cache keys); anything relying on
     * these for actual security guarantees is out of scope for a sandboxed
     * script-execution engine like this one. */
    "globalThis.crypto = {\n"
    "  getRandomValues(arr) {\n"
    "    for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0;\n"
    "    return arr;\n"
    "  },\n"
    "  randomUUID() {\n"
    "    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {\n"
    "      const r = (Math.random() * 16) | 0;\n"
    "      const v = c === 'x' ? r : ((r & 0x3) | 0x8);\n"
    "      return v.toString(16);\n"
    "    });\n"
    "  },\n"
    "  subtle: undefined,\n"
    "};\n"
    /* JSON-round-trip fallback: doesn't preserve Map/Set/Date/typed arrays
     * faithfully like the real structured-clone algorithm, but covers the
     * overwhelmingly common case (cloning plain data objects) without
     * throwing on the rest. */
    "globalThis.structuredClone = function (value) {\n"
    "  if (value === undefined) return undefined;\n"
    "  return JSON.parse(JSON.stringify(value));\n"
    "};\n"
    "globalThis.btoa = function (str) {\n"
    "  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n"
    "  const s = String(str);\n"
    "  let out = '';\n"
    "  for (let i = 0; i < s.length; i += 3) {\n"
    "    const b0 = s.charCodeAt(i) & 0xff;\n"
    "    const b1 = i + 1 < s.length ? s.charCodeAt(i + 1) & 0xff : NaN;\n"
    "    const b2 = i + 2 < s.length ? s.charCodeAt(i + 2) & 0xff : NaN;\n"
    "    out += chars[b0 >> 2];\n"
    "    out += chars[((b0 & 3) << 4) | (isNaN(b1) ? 0 : b1 >> 4)];\n"
    "    out += isNaN(b1) ? '=' : chars[((b1 & 15) << 2) | (isNaN(b2) ? 0 : b2 >> 6)];\n"
    "    out += isNaN(b2) ? '=' : chars[b2 & 63];\n"
    "  }\n"
    "  return out;\n"
    "};\n"
    "globalThis.atob = function (str) {\n"
    "  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n"
    "  const s = String(str).replace(/=+$/, '');\n"
    "  let out = '';\n"
    "  let buffer = 0, bits = 0;\n"
    "  for (const ch of s) {\n"
    "    const idx = chars.indexOf(ch);\n"
    "    if (idx < 0) continue;\n"
    "    buffer = (buffer << 6) | idx;\n"
    "    bits += 6;\n"
    "    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 0xff); }\n"
    "  }\n"
    "  return out;\n"
    "};\n"
    "globalThis.AbortSignal = class AbortSignal {\n"
    "  constructor() { this.aborted = false; this.reason = undefined; this.__listeners = null; this.onabort = null; }\n"
    "  addEventListener(type, fn) { (this.__listeners ??= {})[type] ??= []; this.__listeners[type].push(fn); }\n"
    "  removeEventListener(type, fn) { const l = this.__listeners && this.__listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }\n"
    "  dispatchEvent(ev) {\n"
    "    const l = this.__listeners && this.__listeners[ev.type];\n"
    "    if (l) for (const fn of l.slice()) { try { fn.call(this, ev); } catch (e) { __kk_record_uncaught(ev.type, e); } }\n"
    "    if (ev.type === 'abort' && typeof this.onabort === 'function') { try { this.onabort(ev); } catch (e) { __kk_record_uncaught('abort', e); } }\n"
    "    return true;\n"
    "  }\n"
    "  throwIfAborted() { if (this.aborted) throw this.reason ?? new Error('AbortError'); }\n"
    "  static timeout(ms) { return new AbortSignal(); }\n"
    "};\n"
    "globalThis.AbortController = class AbortController {\n"
    "  constructor() { this.signal = new AbortSignal(); }\n"
    "  abort(reason) {\n"
    "    if (this.signal.aborted) return;\n"
    "    this.signal.aborted = true;\n"
    "    this.signal.reason = reason ?? new Error('AbortError');\n"
    "    this.signal.dispatchEvent(new Event('abort'));\n"
    "  }\n"
    "};\n"
    "globalThis.Headers = class Headers {\n"
    "  constructor(init) {\n"
    "    this.__map = new Map();\n"
    "    if (init instanceof Headers) { for (const [k, v] of init.__map) this.__map.set(k, v); }\n"
    "    else if (Array.isArray(init)) { for (const [k, v] of init) this.set(k, v); }\n"
    "    else if (init) { for (const k of Object.keys(init)) this.set(k, init[k]); }\n"
    "  }\n"
    "  set(name, value) { this.__map.set(String(name).toLowerCase(), String(value)); }\n"
    "  append(name, value) {\n"
    "    const k = String(name).toLowerCase();\n"
    "    this.__map.set(k, this.__map.has(k) ? this.__map.get(k) + ', ' + value : String(value));\n"
    "  }\n"
    "  get(name) { const v = this.__map.get(String(name).toLowerCase()); return v === undefined ? null : v; }\n"
    "  has(name) { return this.__map.has(String(name).toLowerCase()); }\n"
    "  delete(name) { this.__map.delete(String(name).toLowerCase()); }\n"
    "  forEach(fn) { for (const [k, v] of this.__map) fn(v, k, this); }\n"
    "  entries() { return this.__map.entries(); }\n"
    "  keys() { return this.__map.keys(); }\n"
    "  values() { return this.__map.values(); }\n"
    "  [Symbol.iterator]() { return this.__map.entries(); }\n"
    "};\n"
    "globalThis.Blob = class Blob {\n"
    "  constructor(parts, options) {\n"
    "    this.__parts = parts ? Array.from(parts).map(String) : [];\n"
    "    this.type = (options && options.type) || '';\n"
    "  }\n"
    "  get size() { return this.__parts.reduce((n, p) => n + p.length, 0); }\n"
    "  text() { return Promise.resolve(this.__parts.join('')); }\n"
    "  arrayBuffer() { return Promise.resolve(new TextEncoder().encode(this.__parts.join('')).buffer); }\n"
    "  slice(start, end, type) { return new Blob([this.__parts.join('').slice(start, end)], { type: type || this.type }); }\n"
    "};\n"
    "globalThis.FormData = class FormData {\n"
    "  constructor() { this.__entries = []; }\n"
    "  append(k, v) { this.__entries.push([String(k), v]); }\n"
    "  set(k, v) { this.delete(k); this.append(k, v); }\n"
    "  get(k) { const e = this.__entries.find(e => e[0] === k); return e ? e[1] : null; }\n"
    "  getAll(k) { return this.__entries.filter(e => e[0] === k).map(e => e[1]); }\n"
    "  has(k) { return this.__entries.some(e => e[0] === k); }\n"
    "  delete(k) { this.__entries = this.__entries.filter(e => e[0] !== k); }\n"
    "  entries() { return this.__entries[Symbol.iterator](); }\n"
    "  [Symbol.iterator]() { return this.entries(); }\n"
    "};\n"
    "globalThis.Response = class Response {\n"
    "  constructor(body, init) {\n"
    "    this.__body = body === undefined || body === null ? '' : String(body);\n"
    "    this.status = (init && init.status) ?? 200;\n"
    "    this.statusText = (init && init.statusText) || '';\n"
    "    this.ok = this.status >= 200 && this.status < 300;\n"
    "    this.headers = new Headers(init && init.headers);\n"
    "    this.bodyUsed = false;\n"
    "  }\n"
    "  text() { this.bodyUsed = true; return Promise.resolve(this.__body); }\n"
    "  json() { this.bodyUsed = true; return Promise.resolve(JSON.parse(this.__body)); }\n"
    "  clone() { const r = new Response(this.__body, { status: this.status, statusText: this.statusText }); r.headers = this.headers; return r; }\n"
    "  static json(data, init) { return new Response(JSON.stringify(data), { ...(init || {}), headers: new Headers({ 'content-type': 'application/json', ...((init && init.headers) || {}) }) }); }\n"
    "};\n"
    "globalThis.Request = class Request {\n"
    "  constructor(input, init) {\n"
    "    this.url = input instanceof Request ? input.url : String(input);\n"
    "    this.method = (init && init.method) || 'GET';\n"
    "    this.headers = new Headers(init && init.headers);\n"
    "    this.body = (init && init.body) ?? null;\n"
    "  }\n"
    "};\n"
    /* Still extremely common in the wild — plenty of bundler runtime
     * helpers, older libraries (jQuery.ajax's default transport, some
     * analytics loaders) and axios's non-fetch adapter all use XHR
     * directly rather than fetch(). Built on top of our own fetch() shim
     * so it automatically inherits real network access, relative-URL
     * resolution against location, and the drainPendingFetches round-trip
     * — no separate native plumbing needed. */
    "globalThis.XMLHttpRequest = class XMLHttpRequest {\n"
    "  constructor() {\n"
    "    this.UNSENT = 0; this.OPENED = 1; this.HEADERS_RECEIVED = 2; this.LOADING = 3; this.DONE = 4;\n"
    "    this.readyState = 0; this.status = 0; this.statusText = '';\n"
    "    this.responseText = ''; this.response = ''; this.responseType = '';\n"
    "    this.onreadystatechange = null; this.onload = null; this.onerror = null;\n"
    "    this.onabort = null; this.ontimeout = null; this.onloadend = null;\n"
    "    this.withCredentials = false; this.timeout = 0;\n"
    "    this.__listeners = null; this.__headers = {};\n"
    "  }\n"
    "  open(method, url) { this.__method = String(method); this.__url = String(url); this.readyState = 1; this.__fireReadyStateChange(); }\n"
    "  setRequestHeader(name, value) { this.__headers[name] = value; }\n"
    "  overrideMimeType() {}\n"
    "  getAllResponseHeaders() { return ''; }\n"
    "  getResponseHeader() { return null; }\n"
    "  addEventListener(type, fn) { (this.__listeners ??= {})[type] ??= []; this.__listeners[type].push(fn); }\n"
    "  removeEventListener(type, fn) { const l = this.__listeners && this.__listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }\n"
    "  __fireReadyStateChange() {\n"
    "    if (typeof this.onreadystatechange === 'function') { try { this.onreadystatechange(); } catch (e) { __kk_record_uncaught('xhr.onreadystatechange', e); } }\n"
    "    const l = this.__listeners && this.__listeners.readystatechange;\n"
    "    if (l) for (const fn of l.slice()) { try { fn.call(this); } catch (e) { __kk_record_uncaught('xhr.readystatechange', e); } }\n"
    "  }\n"
    "  __fireEvent(type) {\n"
    "    const handler = this['on' + type];\n"
    "    if (typeof handler === 'function') { try { handler.call(this, new Event(type)); } catch (e) { __kk_record_uncaught('xhr.' + type, e); } }\n"
    "    const l = this.__listeners && this.__listeners[type];\n"
    "    if (l) for (const fn of l.slice()) { try { fn.call(this, new Event(type)); } catch (e) { __kk_record_uncaught('xhr.' + type, e); } }\n"
    "  }\n"
    "  send(body) {\n"
    "    fetch(this.__url, { method: this.__method, headers: this.__headers, body })\n"
    "      .then((res) => res.text().then((text) => {\n"
    "        this.status = res.status; this.statusText = res.statusText || '';\n"
    "        this.responseText = text;\n"
    "        this.response = this.responseType === 'json' ? (() => { try { return JSON.parse(text); } catch (e) { return null; } })() : text;\n"
    "        this.readyState = 4;\n"
    "        this.__fireReadyStateChange();\n"
    "        this.__fireEvent('load');\n"
    "        this.__fireEvent('loadend');\n"
    "      }))\n"
    "      .catch(() => {\n"
    "        this.readyState = 4;\n"
    "        this.__fireReadyStateChange();\n"
    "        this.__fireEvent('error');\n"
    "        this.__fireEvent('loadend');\n"
    "      });\n"
    "  }\n"
    "  abort() { this.__fireEvent('abort'); }\n"
    "};\n"
    /* Neither a real event loop nor real threads/sockets exist in this
     * engine, so Worker/WebSocket can't actually do anything — but a class
     * that exists and never throws lets a script's *optional* use of them
     * (progressive enhancement, background compute, live-update sockets)
     * fail to activate quietly instead of crashing the whole boot chain. */
    "globalThis.Worker = class Worker {\n"
    "  constructor(url) { this.url = String(url); this.onmessage = null; this.onerror = null; }\n"
    "  postMessage() {}\n"
    "  terminate() {}\n"
    "  addEventListener() {}\n"
    "  removeEventListener() {}\n"
    "};\n"
    "globalThis.WebSocket = class WebSocket {\n"
    "  constructor(url) { this.url = String(url); this.readyState = 3; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; }\n"
    "  send() {}\n"
    "  close() {}\n"
    "  addEventListener() {}\n"
    "  removeEventListener() {}\n"
    "};\n"
    "globalThis.MessagePort = class MessagePort {\n"
    "  constructor() { this.onmessage = null; this.__other = null; }\n"
    "  postMessage(data) {\n"
    "    const other = this.__other;\n"
    "    if (!other) return;\n"
    "    globalThis.setTimeout(() => {\n"
    "      if (typeof other.onmessage === 'function') other.onmessage({ data });\n"
    "    }, 0);\n"
    "  }\n"
    "  start() {}\n"
    "  close() {}\n"
    "};\n"
    "globalThis.MessageChannel = class MessageChannel {\n"
    "  constructor() {\n"
    "    this.port1 = new MessagePort();\n"
    "    this.port2 = new MessagePort();\n"
    "    this.port1.__other = this.port2;\n"
    "    this.port2.__other = this.port1;\n"
    "  }\n"
    "};\n"
    "globalThis.customElements = (function () {\n"
    "  const registry = new Map();\n"
    "  const waiters = new Map();\n"
    "  return {\n"
    "    define(name, ctor) {\n"
    "      registry.set(name, ctor);\n"
    "      const w = waiters.get(name);\n"
    "      if (w) { w.forEach((resolve) => resolve()); waiters.delete(name); }\n"
    "    },\n"
    "    get(name) { return registry.get(name); },\n"
    "    upgrade() {},\n"
    "    whenDefined(name) {\n"
    "      if (registry.has(name)) return Promise.resolve();\n"
    "      return new Promise((resolve) => { (waiters.get(name) ?? waiters.set(name, []).get(name)).push(resolve); });\n"
    "    },\n"
    "  };\n"
    "})();\n"
    "globalThis.performance = {\n"
    "  __origin: Date.now(),\n"
    "  now() { return Date.now() - this.__origin; },\n"
    "  mark() {},\n"
    "  measure() {},\n"
    "  clearMarks() {},\n"
    "  clearMeasures() {},\n"
    "  getEntries() { return []; },\n"
    "  getEntriesByName() { return []; },\n"
    "  getEntriesByType() { return []; },\n"
    "};\n"
    "globalThis.navigator = {\n"
    "  userAgent: 'kenkage/1.0 (+https://github.com/labKnowledge/kenkage-wasm-package)',\n"
    "  language: 'en-US',\n"
    "  languages: ['en-US'],\n"
    "  platform: '',\n"
    "  vendor: '',\n"
    "  onLine: true,\n"
    "  cookieEnabled: false,\n"
    "  hardwareConcurrency: 1,\n"
    "  maxTouchPoints: 0,\n"
    "  sendBeacon() { return true; },\n"
    "  clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },\n"
    "};\n"
    /* Seeded with a neutral default; loadPage() overwrites this with the
     * real page URL right after fetching it (see index.ts) — plain eval()
     * callers never get a meaningful location, same as a script tag with no
     * navigation context. */
    "globalThis.location = {\n"
    "  href: 'about:blank', protocol: '', host: '', hostname: '', port: '',\n"
    "  pathname: '', search: '', hash: '', origin: 'null',\n"
    "  assign() {}, replace() {}, reload() {}, toString() { return this.href; },\n"
    "};\n"
    "document.location = globalThis.location;\n"
    "globalThis.history = {\n"
    "  state: null, length: 1, scrollRestoration: 'auto',\n"
    "  pushState(state, _title, url) { this.__nav(state, url); },\n"
    "  replaceState(state, _title, url) { this.__nav(state, url); },\n"
    "  __nav(state, url) {\n"
    "    this.state = state ?? null;\n"
    "    if (url === undefined) return;\n"
    "    try {\n"
    "      const next = new URL(String(url), location.href);\n"
    "      Object.assign(location, { href: next.href, pathname: next.pathname, search: next.search, hash: next.hash, origin: next.origin, protocol: next.protocol, host: next.host, hostname: next.hostname, port: next.port });\n"
    "    } catch (e) { __kk_record_uncaught('pushState', e); }\n"
    "  },\n"
    "  back() {}, forward() {}, go() {},\n"
    "};\n"
    "globalThis.ReadableStream = class ReadableStream {\n"
    "  constructor(source) {\n"
    "    this.__chunks = [];\n"
    "    this.__closed = false;\n"
    "    const controller = {\n"
    "      enqueue: (chunk) => { this.__chunks.push(chunk); },\n"
    "      close: () => { this.__closed = true; },\n"
    "      error: (e) => { this.__closed = true; this.__error = e; },\n"
    "    };\n"
    "    if (source && typeof source.start === 'function') {\n"
    "      try { source.start(controller); } catch (e) { __kk_record_uncaught('ReadableStream.start', e); }\n"
    "    }\n"
    "  }\n"
    "  getReader() {\n"
    "    const self = this;\n"
    "    let i = 0;\n"
    "    return {\n"
    "      read() {\n"
    "        if (i < self.__chunks.length) return Promise.resolve({ done: false, value: self.__chunks[i++] });\n"
    "        return Promise.resolve({ done: true, value: undefined });\n"
    "      },\n"
    "      releaseLock() {},\n"
    "      cancel() { return Promise.resolve(); },\n"
    "    };\n"
    "  }\n"
    "};\n"
    /* Real WeakRef/FinalizationRegistry need GC hooks this engine doesn't
     * expose; these fall back to always-strong (deref() never returns
     * undefined) and never-invoked cleanup respectively — wrong in the
     * memory-reclamation sense, harmless for the far more common case of
     * code that merely feature-detects or uses them as an optimization
     * hint rather than a correctness requirement. */
    "globalThis.WeakRef = class WeakRef {\n"
    "  constructor(target) { this.__target = target; }\n"
    "  deref() { return this.__target; }\n"
    "};\n"
    "globalThis.FinalizationRegistry = class FinalizationRegistry {\n"
    "  constructor(cleanup) { this.__cleanup = cleanup; }\n"
    "  register() {}\n"
    "  unregister() {}\n"
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
