/**
 * kenkage — Next.js helpers
 *
 * Server-side HTML parsing for Next.js App Router (React Server Components)
 * and Pages Router.
 */

import {
  createKenkage,
  type KenkageWasm,
} from './index';

// ── Singleton cache for server-side reuse ────────────────────────

let serverInstance: KenkageWasm | null = null;

/**
 * Create (or reuse) a Kenkage WASM instance on the server.
 *
 * In a server environment (Next.js RSC, API routes, etc.), the WASM
 * module is loaded once via `fs.readFileSync` and instantiated. The
 * instance is reused across calls for efficiency.
 *
 * @example
 * ```ts
 * // In a Next.js Server Component or API route:
 * const engine = await createKenkagePage(htmlString);
 * console.log(engine.getTitle());
 * engine.destroy(); // or let it be reused
 * ```
 */
export async function createKenkagePage(
  html: string,
): Promise<KenkageWasm> {
  // Reuse existing instance if available
  if (serverInstance) {
    serverInstance.parse(html);
    return serverInstance;
  }

  const engine = await createKenkage();
  await engine.init();
  engine.parse(html);
  serverInstance = engine;
  return engine;
}

// ── JSON-serializable parse result ────────────────────────────────

export interface KenkageParseResult {
  title: string;
  text: string;
  html: string;
  markdown: string;
  nodeCount: number;
}

/**
 * React Server Component that parses HTML and exposes the result
 * as a JSON-serializable object.
 *
 * Use this in Next.js App Router server components to parse HTML
 * on the server and pass structured data to client components.
 *
 * @example
 * ```tsx
 * // app/page.tsx (Server Component)
 * import { KenkageHtmlParser } from 'kenkage/next';
 *
 * export default async function Page() {
 *   const html = await fetch('https://example.com').then(r => r.text());
 *   const result = <KenkageHtmlParser html={html} />;
 *   // result is a JSON object, not JSX — it's a helper pattern
 * }
 * ```
 */
export async function KenkageHtmlParser({
  html,
}: {
  html: string;
}): Promise<KenkageParseResult> {
  const engine = await createKenkagePage(html);
  const result: KenkageParseResult = {
    title: engine.getTitle(),
    text: engine.getText(),
    html: engine.getHtml(),
    markdown: engine.getMarkdown(),
    nodeCount: engine.getNodeCount(),
  };
  // Don't destroy — allow reuse on next request
  return result;
}
