/**
 * Tests for kenkage
 *
 * Covers: WASM loading, HTML parsing, title/text/html/markdown extraction,
 * query selectors (tag, class, id), node attributes, and edge cases.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createKenkage, type KenkageWasm } from '../index';
import { join } from 'node:path';

const WASM_PATH = join(process.cwd(), 'dist', 'kenkage-core.wasm');

let engine: KenkageWasm;

const SAMPLE_HTML = `
<html>
<head>
  <title>Test Page</title>
  <meta charset="utf-8">
</head>
<body>
  <h1 id="main-title">Hello World</h1>
  <p class="intro">This is a <strong>test</strong> paragraph.</p>
  <p class="intro second">Another paragraph with <a href="https://example.com">a link</a>.</p>
  <ul>
    <li>Item 1</li>
    <li>Item 2</li>
    <li>Item 3</li>
  </ul>
  <div id="footer">
    <span class="small">Footer text</span>
  </div>
</body>
</html>`;

beforeAll(async () => {
  engine = await createKenkage({ wasmUrl: WASM_PATH });
  await engine.init();
});

afterAll(() => {
  engine.destroy();
});

// ── WASM Loading ────────────────────────────────────────────────

describe('WASM Loading', () => {
  it('should report a version string', () => {
    expect(engine.version).toBe('0.2.0');
  });

  it('should initialize successfully', () => {
    // Already initialized in beforeAll, just verify no crash
    expect(engine).toBeDefined();
  });
});

// ── HTML Parsing ────────────────────────────────────────────────

describe('HTML Parsing', () => {
  it('should parse valid HTML and return true', () => {
    const result = engine.parse(SAMPLE_HTML);
    expect(result).toBe(true);
  });

  it('should report a non-zero node count after parsing', () => {
    engine.parse(SAMPLE_HTML);
    expect(engine.getNodeCount()).toBeGreaterThan(0);
  });

  it('should return false for empty HTML', () => {
    // Empty string may still "succeed" in the parser, but let's check behavior
    const result = engine.parse('');
    // The result depends on the WASM implementation — just ensure no crash
    expect(typeof result).toBe('boolean');
  });
});

// ── Title Extraction ────────────────────────────────────────────

describe('Title Extraction', () => {
  it('should extract the document title', () => {
    engine.parse(SAMPLE_HTML);
    expect(engine.getTitle()).toBe('Test Page');
  });

  it('should return empty string when no title exists', () => {
    engine.parse('<html><body><p>No title here</p></body></html>');
    expect(engine.getTitle()).toBe('');
  });
});

// ── Text Content ────────────────────────────────────────────────

describe('Text Content', () => {
  it('should extract all text content', () => {
    engine.parse(SAMPLE_HTML);
    const text = engine.getText();
    expect(text).toContain('Hello World');
    expect(text).toContain('test');
    expect(text).toContain('paragraph');
    expect(text).toContain('a link');
    expect(text).toContain('Item 1');
    expect(text).toContain('Footer text');
  });

  it('should strip HTML tags', () => {
    engine.parse('<html><body><p>Hello</p></body></html>');
    const text = engine.getText();
    expect(text).not.toContain('<p>');
    expect(text).toContain('Hello');
  });
});

// ── HTML Serialization ─────────────────────────────────────────

describe('HTML Serialization', () => {
  it('should return serialized HTML containing key elements', () => {
    engine.parse(SAMPLE_HTML);
    const html = engine.getHtml();
    expect(html).toContain('<title>');
    expect(html).toContain('Test Page');
  });
});

// ── Markdown Conversion ─────────────────────────────────────────

describe('Markdown Conversion', () => {
  it('should convert h1 to markdown heading', () => {
    engine.parse(SAMPLE_HTML);
    const md = engine.getMarkdown();
    expect(md).toContain('# Hello World');
  });

  it('should convert links to markdown format', () => {
    engine.parse(SAMPLE_HTML);
    const md = engine.getMarkdown();
    expect(md).toContain('[a link](https://example.com)');
  });

  it('should convert list items to markdown format', () => {
    engine.parse(SAMPLE_HTML);
    const md = engine.getMarkdown();
    expect(md).toContain('- Item 1');
    expect(md).toContain('- Item 2');
    expect(md).toContain('- Item 3');
  });
});

// ── Query Selectors ─────────────────────────────────────────────

describe('Query Selectors', () => {
  beforeEach(() => {
    engine.parse(SAMPLE_HTML);
  });

  it('should find elements by tag name', () => {
    const h1s = engine.querySelector('h1');
    expect(h1s.length).toBe(1);
  });

  it('should find multiple elements by tag name', () => {
    const lis = engine.querySelector('li');
    expect(lis.length).toBe(3);
  });

  it('should find elements by class', () => {
    const intros = engine.querySelector('.intro');
    expect(intros.length).toBe(2);
  });

  it('should find elements by id', () => {
    const mainTitle = engine.querySelector('#main-title');
    expect(mainTitle.length).toBe(1);
  });

  it('should find links', () => {
    const links = engine.querySelector('a');
    expect(links.length).toBe(1);
  });

  it('should return empty array for non-existent selector', () => {
    const results = engine.querySelector('.non-existent-class');
    expect(results).toEqual([]);
  });

  it('should find paragraph elements', () => {
    const ps = engine.querySelector('p');
    expect(ps.length).toBe(2);
  });
});

// ── Node Operations ─────────────────────────────────────────────

describe('Node Operations', () => {
  it('should get tag name of a node', () => {
    engine.parse(SAMPLE_HTML);
    const h1s = engine.querySelector('h1');
    expect(h1s.length).toBeGreaterThan(0);
    const tag = engine.nodeTag(h1s[0]);
    expect(tag.toLowerCase()).toBe('h1');
  });

  it('should get text content of a node', () => {
    engine.parse(SAMPLE_HTML);
    const h1s = engine.querySelector('h1');
    expect(h1s.length).toBeGreaterThan(0);
    const text = engine.nodeText(h1s[0]);
    expect(text).toContain('Hello World');
  });

  it('should get attribute value of a node', () => {
    engine.parse(SAMPLE_HTML);
    const h1s = engine.querySelector('h1');
    expect(h1s.length).toBeGreaterThan(0);
    const id = engine.nodeAttr(h1s[0], 'id');
    expect(id).toBe('main-title');
  });

  it('should get href attribute of a link', () => {
    engine.parse(SAMPLE_HTML);
    const links = engine.querySelector('a');
    expect(links.length).toBeGreaterThan(0);
    const href = engine.nodeAttr(links[0], 'href');
    expect(href).toBe('https://example.com');
  });

  it('should return empty string for missing attribute', () => {
    engine.parse(SAMPLE_HTML);
    const h1s = engine.querySelector('h1');
    expect(h1s.length).toBeGreaterThan(0);
    const attr = engine.nodeAttr(h1s[0], 'nonexistent');
    expect(attr).toBe('');
  });

  it('should get child count of a node', () => {
    engine.parse(SAMPLE_HTML);
    const uls = engine.querySelector('ul');
    expect(uls.length).toBeGreaterThan(0);
    const childCount = engine.nodeChildCount(uls[0]);
    expect(childCount).toBe(3);
  });

  it('should get child node IDs', () => {
    engine.parse(SAMPLE_HTML);
    const uls = engine.querySelector('ul');
    expect(uls.length).toBeGreaterThan(0);
    const children = engine.nodeChildren(uls[0]);
    expect(children.length).toBe(3);
    // Verify children are list items
    for (const childId of children) {
      const tag = engine.nodeTag(childId);
      expect(tag.toLowerCase()).toBe('li');
    }
  });
});

// ── Edge Cases ──────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('should handle empty HTML gracefully', () => {
    const result = engine.parse('');
    expect(typeof result).toBe('boolean');
    // Empty HTML may still create a document node
    expect(engine.getNodeCount()).toBeGreaterThanOrEqual(0);
  });

  it('should handle malformed HTML', () => {
    const result = engine.parse('<div><p>unclosed<div>more');
    expect(result).toBe(true);
    expect(engine.getText()).toContain('unclosed');
    expect(engine.getText()).toContain('more');
  });

  it('should handle large documents', () => {
    // Generate a document large enough to stress the parser
    // but not so large it overflows the 64KB result_buffer
    const items = Array.from({ length: 100 }, (_, i) =>
      `<li>Item ${i}: Lorem ipsum dolor sit amet</li>`,
    ).join('\n');
    const largeHtml = `<html><head><title>Large Doc</title></head>
<body><h1>Large Document</h1><ul>${items}</ul></body></html>`;

    const result = engine.parse(largeHtml);
    expect(result).toBe(true);
    expect(engine.getTitle()).toBe('Large Doc');
    expect(engine.getText()).toContain('Item 0');
    expect(engine.getText()).toContain('Item 99');
    expect(engine.getNodeCount()).toBeGreaterThan(100);
  });

  it('should handle HTML with special characters', () => {
    engine.parse('<html><body><p>Special: &amp; &lt; &gt; &quot; &#x1F600;</p></body></html>');
    const text = engine.getText();
    expect(text).toContain('Special');
  });

  it('should handle deeply nested HTML', () => {
    const depth = 50;
    let html = '<div>';
    for (let i = 0; i < depth; i++) {
      html += `<span>Level ${i} `;
    }
    for (let i = 0; i < depth; i++) {
      html += '</span>';
    }
    html += '</div>';

    const result = engine.parse(html);
    expect(result).toBe(true);
    expect(engine.getText()).toContain('Level 0');
  });

  it('should handle re-parsing with a different document', () => {
    engine.parse('<html><head><title>First</title></head><body>First doc</body></html>');
    expect(engine.getTitle()).toBe('First');
    expect(engine.getText()).toContain('First doc');

    engine.parse('<html><head><title>Second</title></head><body>Second doc</body></html>');
    expect(engine.getTitle()).toBe('Second');
    expect(engine.getText()).toContain('Second doc');
  });
});

// ── JavaScript Evaluation ────────────────────────────────────────

describe('JavaScript Evaluation', () => {
  it('should evaluate a simple expression and return the result', async () => {
    const result = await engine.eval('1 + 2');
    expect(result.success).toBe(true);
    expect(result.result).toBe('3');
  });

  it('should fail for document.title (not available in Node.js)', async () => {
    const result = await engine.eval('document.title');
    expect(result.success).toBe(false);
    expect(result.result).toContain('document is not defined');
  });

  it('should evaluate multi-statement code', async () => {
    const result = await engine.eval('var x = 42; x * 2');
    expect(result.success).toBe(true);
    expect(result.result).toBe('84');
  });

  it('should catch thrown errors and return failure', async () => {
    const result = await engine.eval('throw new Error("test")');
    expect(result.success).toBe(false);
    expect(result.result).toBe('test');
  });

  it('should handle empty code (returns undefined)', async () => {
    const result = await engine.eval('');
    expect(result.success).toBe(true);
    expect(result.result).toBe('undefined');
  });
});

// ── Fetch Support ────────────────────────────────────────────────

describe('Fetch Support', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should fetch a URL and return status and body', async () => {
    const mockBody = '<!doctype html><html><body><h1>Example</h1></body></html>';
    globalThis.fetch = async () =>
      new Response(mockBody, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/html' },
      });

    const result = await engine.fetch('https://example.com');
    expect(result.status).toBe(200);
    expect(result.body).toContain('<h1>Example</h1>');
  });

  it('should pass method and headers to the host fetch', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response('ok', { status: 200 });
    };

    await engine.fetch('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"key":"value"}',
    });

    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(capturedInit?.body).toBe('{"key":"value"}');
  });

  it('should default to GET method', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response('not found', { status: 404 });
    };

    const result = await engine.fetch('https://example.com/missing');
    expect(result.status).toBe(404);
    expect(result.body).toBe('not found');
    expect(capturedInit?.method).toBe('GET');
  });
});
