import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createKenkage } from 'kenkage';

// Response fields that carry page content (text/html/markdown) are capped so
// a single tool call can't flood the calling agent's context with a huge page.
const MAX_FIELD_LENGTH = 20000;

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
  version: '0.1.0',
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

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
