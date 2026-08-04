'use client';

import { useEffect, useRef, useState } from 'react';
import type { KenkageWasm } from 'kenkage';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const SAMPLE_HTML = `<html>
<head><title>Hello WASM</title></head>
<body>
  <h1 id="headline" class="title">A browser engine in WebAssembly</h1>
  <p>No server. No bridge. Parsed and rendered entirely in your browser.</p>
  <ul>
    <li>HTML parsing</li>
    <li>DOM tree + CSS selectors</li>
    <li>Real JavaScript, running inside the sandbox</li>
  </ul>
  <p>Try navigating to
    <a href="https://cdn.jsdelivr.net/gh/h5bp/html5-boilerplate@main/dist/index.html">a CORS-friendly page</a>
    or <a href="https://takenolab.com">takenolab.com</a> below.</p>
</body>
</html>`;

const SAMPLE_JS = `const nums = [5, 3, 1, 4, 2];
nums.sort((a, b) => a - b).join(", ")`;

const SAMPLE_FETCH_URL =
  'https://cdn.jsdelivr.net/gh/h5bp/html5-boilerplate@main/dist/index.html';

type EngineState = 'loading' | 'ready' | 'error';

export default function Home() {
  const engineRef = useRef<KenkageWasm | null>(null);
  const [engineState, setEngineState] = useState<EngineState>('loading');
  const [engineError, setEngineError] = useState<string | null>(null);

  const [html, setHtml] = useState(SAMPLE_HTML);
  const [parsed, setParsed] = useState<{
    title: string;
    text: string;
    markdown: string;
    nodeCount: number;
  } | null>(null);

  const [selector, setSelector] = useState('.title');
  const [queryResult, setQueryResult] = useState<
    { id: number; tag: string; text: string }[] | null
  >(null);

  const [jsCode, setJsCode] = useState(SAMPLE_JS);
  const [jsResult, setJsResult] = useState<{ success: boolean; result: string } | null>(null);
  const [jsRunning, setJsRunning] = useState(false);

  const [fetchUrl, setFetchUrl] = useState(SAMPLE_FETCH_URL);
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchVia, setFetchVia] = useState<'direct' | 'proxy' | null>(null);

  // The URL of whatever's currently parsed — null for hand-typed/sample HTML
  // with no real origin, so relative links in it can't be resolved.
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [urlHistory, setUrlHistory] = useState<string[]>([]);
  const [links, setLinks] = useState<
    { id: number; href: string; text: string; resolvedUrl: string | null }[]
  >([]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { createKenkage } = await import('kenkage');
        const engine = await createKenkage({
          engine: 'full',
          wasmUrl: '/wasm/kenkage-full.wasm',
        });
        await engine.init();
        if (cancelled) {
          engine.destroy();
          return;
        }
        engineRef.current = engine;
        setEngineState('ready');
        parseAndDisplay(engine, SAMPLE_HTML, null);
      } catch (err) {
        if (cancelled) return;
        setEngineError(err instanceof Error ? err.message : String(err));
        setEngineState('error');
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  function parseAndDisplay(engine: KenkageWasm, source: string, baseUrl: string | null) {
    engine.parse(source);
    setParsed({
      title: engine.getTitle(),
      text: engine.getText(),
      markdown: engine.getMarkdown(),
      nodeCount: engine.getNodeCount(),
    });
    setQueryResult(null);

    // Extract every <a href> so they can be clicked to navigate, same as a
    // real browser. Relative hrefs need baseUrl to resolve; without one
    // (hand-typed HTML with no fetch behind it) only absolute links work.
    const ids = engine.querySelector('a');
    setLinks(
      ids
        .map((id) => {
          const href = engine.nodeAttr(id, 'href');
          const text = engine.nodeText(id).trim();
          let resolvedUrl: string | null = null;
          if (href) {
            try {
              resolvedUrl = baseUrl ? new URL(href, baseUrl).toString() : new URL(href).toString();
            } catch {
              resolvedUrl = null;
            }
          }
          return { id, href, text, resolvedUrl };
        })
        .filter((link) => link.href),
    );
  }

  function handleParse() {
    const engine = engineRef.current;
    if (!engine) return;
    parseAndDisplay(engine, html, currentUrl);
  }

  async function loadUrl(url: string, pushCurrentToHistory: boolean) {
    const engine = engineRef.current;
    if (!engine) return;
    setFetching(true);
    setFetchError(null);
    setFetchStatus(null);
    setFetchVia(null);

    async function afterSuccess(status: number, body: string, via: 'direct' | 'proxy') {
      if (pushCurrentToHistory && currentUrl) {
        setUrlHistory((h) => [...h, currentUrl]);
      }
      setFetchStatus(status);
      setFetchVia(via);
      setFetchUrl(url);
      setCurrentUrl(url);
      setHtml(body);
      parseAndDisplay(engine!, body, url);
    }

    // 1. Try the real browser fetch() first — the WASM engine has no network
    // access of its own (nor should it: raw sockets from a browser tab
    // aren't a thing). Works for any CORS-friendly URL with zero server
    // involvement, which is the point of this demo.
    try {
      const { status, body } = await engine.fetch(url);
      await afterSuccess(status, body, 'direct');
      setFetching(false);
      return;
    } catch {
      // Fall through to the proxy — most sites don't send the CORS headers
      // required for a page on this origin to read their response directly.
    }

    // 2. Fallback: a local Next.js route does the fetch server-side (Node
    // has no CORS restriction) and hands the bytes back. The WASM engine
    // still does 100% of the actual HTML parsing, same as the direct path.
    try {
      const res = await fetch(`/api/fetch-url?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Proxy request failed (${res.status})`);
      await afterSuccess(data.status, data.body, 'proxy');
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }

  function handleFetch() {
    loadUrl(fetchUrl, true);
  }

  function handleLinkClick(url: string) {
    loadUrl(url, true);
  }

  function handleBack() {
    if (urlHistory.length === 0) return;
    const previous = urlHistory[urlHistory.length - 1];
    setUrlHistory((h) => h.slice(0, -1));
    loadUrl(previous, false);
  }

  function handleQuery() {
    const engine = engineRef.current;
    if (!engine) return;
    const ids = engine.querySelector(selector);
    setQueryResult(
      ids.map((id) => ({
        id,
        tag: engine.nodeTag(id),
        text: engine.nodeText(id),
      })),
    );
  }

  async function handleEval() {
    const engine = engineRef.current;
    if (!engine) return;
    setJsRunning(true);
    try {
      const result = await engine.eval(jsCode);
      setJsResult(result);
    } finally {
      setJsRunning(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-12 space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">kenkage</h1>
            {engineState === 'loading' && <Badge variant="secondary">loading engine…</Badge>}
            {engineState === 'ready' && (
              <Badge className="bg-emerald-600 text-white border-transparent">
                engine ready — {engineRef.current?.version}
              </Badge>
            )}
            {engineState === 'error' && <Badge variant="destructive">engine failed to load</Badge>}
          </div>
          <p className="text-muted-foreground max-w-2xl">
            A browser engine written in Zig, compiled to WebAssembly. HTML parsing, a DOM tree,
            CSS selectors, and a real QuickJS JavaScript engine all run here, in this page,
            entirely client-side — no server, no bridge.
          </p>
          {engineState === 'error' && (
            <p className="text-sm text-destructive font-mono">{engineError}</p>
          )}
        </header>

        <Tabs defaultValue="dom">
          <TabsList>
            <TabsTrigger value="dom">HTML / DOM</TabsTrigger>
            <TabsTrigger value="js">JavaScript (QuickJS)</TabsTrigger>
          </TabsList>

          <TabsContent value="dom" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Navigate to a URL</CardTitle>
                <CardDescription>
                  The browser's real <code>fetch()</code> retrieves the bytes (a WASM sandbox has
                  no network access of its own); the WASM engine then parses the response — no
                  server in between. Click a link below to keep navigating, the same as a real
                  browser.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleBack}
                    disabled={engineState !== 'ready' || fetching || urlHistory.length === 0}
                  >
                    ← Back
                  </Button>
                  <Input
                    value={fetchUrl}
                    onChange={(e) => setFetchUrl(e.target.value)}
                    placeholder="https://example.com"
                    className="font-mono text-sm"
                    disabled={engineState !== 'ready' || fetching}
                  />
                  <Button
                    onClick={handleFetch}
                    disabled={engineState !== 'ready' || fetching}
                  >
                    {fetching ? 'Loading…' : 'Go'}
                  </Button>
                </div>
                {fetchStatus !== null && !fetchError && (
                  <div className="text-xs text-muted-foreground">
                    HTTP {fetchStatus} — parsed below.{' '}
                    {fetchVia === 'direct' ? (
                      <span>
                        Fetched directly by the browser, no server involved — this site sends
                        CORS headers allowing it.
                      </span>
                    ) : (
                      <span>
                        This site blocks direct cross-origin browser requests, so the bytes came
                        via a local proxy route instead — the WASM engine still did all the
                        parsing.
                      </span>
                    )}
                  </div>
                )}
                {fetchError && (
                  <div className="text-sm bg-destructive/10 text-destructive rounded px-2 py-1">
                    {fetchError}
                  </div>
                )}

                {links.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Links found on this page ({links.length})
                    </div>
                    <div className="space-y-1">
                      {links.map((link) => (
                        <div
                          key={link.id}
                          className="text-sm font-mono bg-muted rounded px-2 py-1 flex items-center gap-2"
                        >
                          {link.resolvedUrl ? (
                            <button
                              type="button"
                              onClick={() => handleLinkClick(link.resolvedUrl!)}
                              disabled={engineState !== 'ready' || fetching}
                              className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 disabled:no-underline text-left"
                            >
                              {link.text || link.resolvedUrl}
                            </button>
                          ) : (
                            <span
                              className="text-muted-foreground"
                              title="Relative link — no base URL to resolve it against (this page wasn't fetched from a real URL)"
                            >
                              {link.text || link.href} <span className="italic">(unresolvable)</span>
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Parse HTML</CardTitle>
                <CardDescription>
                  Runs entirely in WASM memory — hand-written HTML5 tokenizer and DOM builder.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                  rows={10}
                  className="font-mono text-sm"
                  disabled={engineState !== 'ready'}
                />
                <Button onClick={handleParse} disabled={engineState !== 'ready'}>
                  Parse
                </Button>

                {parsed && (
                  <div className="grid gap-3 pt-2 sm:grid-cols-2">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Title</div>
                      <div className="text-sm font-mono bg-muted rounded px-2 py-1">
                        {parsed.title || '(none)'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">
                        Node count
                      </div>
                      <div className="text-sm font-mono bg-muted rounded px-2 py-1">
                        {parsed.nodeCount}
                      </div>
                    </div>
                    <div className="sm:col-span-2">
                      <div className="text-xs font-medium text-muted-foreground mb-1">
                        Text content
                      </div>
                      <div className="text-sm bg-muted rounded px-2 py-1 whitespace-pre-wrap">
                        {parsed.text}
                      </div>
                    </div>
                    <div className="sm:col-span-2">
                      <div className="text-xs font-medium text-muted-foreground mb-1">
                        Markdown
                      </div>
                      <pre className="text-sm bg-muted rounded px-2 py-1 whitespace-pre-wrap font-mono">
                        {parsed.markdown}
                      </pre>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>CSS selector query</CardTitle>
                <CardDescription>
                  Supports tag, <code>#id</code>, <code>.class</code>, <code>[attr]</code>,{' '}
                  <code>[attr=value]</code>, and <code>*</code>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={selector}
                    onChange={(e) => setSelector(e.target.value)}
                    placeholder="e.g. .title, #headline, li"
                    className="font-mono"
                    disabled={engineState !== 'ready'}
                  />
                  <Button onClick={handleQuery} disabled={engineState !== 'ready'}>
                    Query
                  </Button>
                </div>
                {queryResult && (
                  <div className="space-y-1">
                    {queryResult.length === 0 && (
                      <div className="text-sm text-muted-foreground">No matches.</div>
                    )}
                    {queryResult.map((node) => (
                      <div
                        key={node.id}
                        className="text-sm font-mono bg-muted rounded px-2 py-1 flex gap-2"
                      >
                        <span className="text-muted-foreground">#{node.id}</span>
                        <span className="text-blue-600 dark:text-blue-400">&lt;{node.tag}&gt;</span>
                        <span className="truncate">{node.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="js" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Real JavaScript execution</CardTitle>
                <CardDescription>
                  This runs on QuickJS compiled into the same WASM module — a genuine, sandboxed
                  JS engine, not <code>eval()</code> in the host page.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={jsCode}
                  onChange={(e) => setJsCode(e.target.value)}
                  rows={6}
                  className="font-mono text-sm"
                  disabled={engineState !== 'ready'}
                />
                <Button onClick={handleEval} disabled={engineState !== 'ready' || jsRunning}>
                  {jsRunning ? 'Running…' : 'Run'}
                </Button>

                {jsResult && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      {jsResult.success ? 'Result' : 'Error'}
                    </div>
                    <pre
                      className={`text-sm rounded px-2 py-1 font-mono whitespace-pre-wrap ${
                        jsResult.success
                          ? 'bg-muted'
                          : 'bg-destructive/10 text-destructive'
                      }`}
                    >
                      {jsResult.result}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
