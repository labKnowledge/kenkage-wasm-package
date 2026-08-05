import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createKenkage } from 'kenkage';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Response fields that carry page content (text/html/markdown) are capped so
// a single tool call can't flood the calling agent's context with a huge page.
const MAX_FIELD_LENGTH = 20000;

// Read straight from package.json rather than any in-engine version string:
// the WASM engine exposes its own internal version (`engine.version`, via
// kk_version()), but that's a separate number baked into the Zig source at
// build time and drifts out of sync with the npm package version (observed
// firsthand: engine.version reads "0.2.0" while the installed kenkage
// package.json says "0.3.0") — package.json is what an agent actually needs
// to know when deciding whether a fix it's expecting has shipped.
const require = createRequire(import.meta.url);

// kenkage's own package.json declares an `exports` map that doesn't expose
// `./package.json` as a subpath, so `require.resolve('kenkage/package.json')`
// is refused outright by Node's resolver - has to go the long way: resolve
// the package's real entry file, then walk up directories until finding the
// package.json that actually names it (handles it living directly under
// node_modules/kenkage or nested deeper under npm's own dedup layout).
function findPackageJson(resolvedEntryFile, expectedName) {
  let dir = dirname(resolvedEntryFile);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === expectedName) return pkg;
    } catch {
      // no package.json here, or it belongs to something else - keep going up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find package.json for "${expectedName}" above ${resolvedEntryFile}`);
}

const mcpPackageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const kenkagePackageJson = findPackageJson(require.resolve('kenkage'), 'kenkage');

function truncate(value) {
  if (typeof value !== 'string' || value.length <= MAX_FIELD_LENGTH) return value;
  return value.slice(0, MAX_FIELD_LENGTH) + `\n…[truncated, ${value.length} total characters]`;
}

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

const server = new McpServer({
  name: 'kenkage-mcp',
  version: mcpPackageJson.version,
});

server.registerTool(
  'load_page',
  {
    title: 'Load a live web page',
    description:
      'Fetches a real URL, parses it, and runs its classic <script> tags against a real DOM — all inside an isolated in-WASM sandbox (kenkage), not a headless browser and not a server round-trip. Use this to read what a page actually says and does, including content that only appears after its scripts run. Note: like any on-device fetch, this is subject to the target site sending permissive CORS-equivalent access at the network layer used by the runtime — most sites work, some may not respond.',
    inputSchema: {
      url: z.string().url().describe('The URL to load, e.g. https://example.com'),
    },
  },
  async ({ url }) => {
    let engine;
    try {
      engine = await createKenkage({ engine: 'full' });
      await engine.init();
      const page = await engine.loadPage(url);
      return textResult({
        status: page.status,
        title: page.title,
        text: truncate(page.text),
        scriptsExecuted: page.scriptsExecuted,
        scriptsSkipped: page.scriptsSkipped,
        scriptErrors: page.scriptErrors,
        uncaughtErrors: page.uncaughtErrors,
        consoleMessages: page.consoleMessages,
      });
    } catch (err) {
      return errorResult(err);
    } finally {
      engine?.destroy();
    }
  }
);

server.registerTool(
  'parse_html',
  {
    title: 'Parse an HTML string',
    description:
      'Parses an HTML string you already have (no network fetch) and returns its title, plain text, and Markdown conversion, using kenkage\'s WASM DOM engine. Use this for HTML you\'ve already retrieved from elsewhere, or LLM/tool-generated markup you want to safely inspect without executing any scripts in it.',
    inputSchema: {
      html: z.string().describe('The HTML document or fragment to parse'),
    },
  },
  async ({ html }) => {
    let engine;
    try {
      engine = await createKenkage({ engine: 'core' });
      await engine.init();
      const ok = engine.parse(html);
      if (!ok) return errorResult(new Error('Failed to parse the provided HTML'));
      return textResult({
        title: engine.getTitle(),
        text: truncate(engine.getText()),
        markdown: truncate(engine.getMarkdown()),
        nodeCount: engine.getNodeCount(),
      });
    } catch (err) {
      return errorResult(err);
    } finally {
      engine?.destroy();
    }
  }
);

server.registerTool(
  'query_selector',
  {
    title: 'Query an HTML string with a CSS selector',
    description:
      'Parses an HTML string and returns the tag name and text content of every element matching a CSS selector, using kenkage\'s WASM DOM engine. Use this to extract specific elements (links, headings, list items, etc.) from HTML you already have.',
    inputSchema: {
      html: z.string().describe('The HTML document or fragment to parse'),
      selector: z.string().describe('CSS selector, e.g. "a", ".title", "#main p"'),
    },
  },
  async ({ html, selector }) => {
    let engine;
    try {
      engine = await createKenkage({ engine: 'core' });
      await engine.init();
      const ok = engine.parse(html);
      if (!ok) return errorResult(new Error('Failed to parse the provided HTML'));
      const ids = engine.querySelector(selector);
      const matches = ids.map((id) => ({
        tag: engine.nodeTag(id),
        text: truncate(engine.nodeText(id)),
      }));
      return textResult({ count: matches.length, matches });
    } catch (err) {
      return errorResult(err);
    } finally {
      engine?.destroy();
    }
  }
);

server.registerTool(
  'eval_js',
  {
    title: 'Run JavaScript in an isolated sandbox',
    description:
      'Runs untrusted or model-generated JavaScript inside kenkage\'s in-WASM QuickJS engine — isolated by construction (WASM linear memory), not by a spawned process or a DOM-shim\'s best-effort discipline. Optionally parse an HTML string first so the code runs against a real document/DOM. Use this whenever you need to execute JS you don\'t fully trust, instead of evaluating it in your own process.',
    inputSchema: {
      code: z.string().describe('JavaScript source to evaluate'),
      html: z.string().optional().describe('Optional HTML to parse first, giving the code a document/DOM to act on'),
    },
  },
  async ({ code, html }) => {
    let engine;
    try {
      engine = await createKenkage({ engine: 'full' });
      await engine.init();
      if (html) {
        const ok = engine.parse(html);
        if (!ok) return errorResult(new Error('Failed to parse the provided HTML'));
      }
      const result = await engine.eval(code);
      return textResult({ success: result.success, result: truncate(result.result) });
    } catch (err) {
      return errorResult(err);
    } finally {
      engine?.destroy();
    }
  }
);

server.registerTool(
  'get_versions',
  {
    title: 'Get kenkage-mcp and kenkage versions',
    description:
      "Reports the installed version of this MCP server (kenkage-mcp) and of the kenkage engine package it depends on, straight from their package.json files. Use this to check what's actually running — e.g. to confirm a specific fix has shipped — without guessing from behavior. Deliberately does not use the WASM engine's own internal version string (exposed as `version` on a created engine instance): that number is baked into the Zig source separately from the npm package version and can drift out of sync with it (observed: engine-internal version read '0.2.0' while the installed kenkage package.json said '0.3.0'), so it's an unreliable answer to \"what version of kenkage is this.\"",
    inputSchema: {},
  },
  async () => {
    return textResult({
      kenkageMcp: { name: mcpPackageJson.name, version: mcpPackageJson.version },
      kenkage: { name: kenkagePackageJson.name, version: kenkagePackageJson.version },
    });
  }
);

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
