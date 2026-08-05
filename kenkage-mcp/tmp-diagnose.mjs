import { createKenkage } from 'kenkage';
import { writeFileSync } from 'node:fs';

const TARGET_URL = process.argv[2] ?? 'https://www.ycombinator.com/companies';

const engine = await createKenkage({ engine: 'full' });
await engine.init();

const networkLog = [];

async function trackedFetch(url) {
  const startedAt = Date.now();
  try {
    const res = await engine.fetch(url);
    networkLog.push({
      url,
      method: 'GET',
      status: res.status,
      bodySize: res.body.length,
      durationMs: Date.now() - startedAt,
      ok: true,
    });
    return res;
  } catch (err) {
    networkLog.push({
      url,
      method: 'GET',
      status: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      ok: false,
    });
    throw err;
  }
}

const page = await engine.loadPage(TARGET_URL, { fetchFn: trackedFetch });

engine.destroy();

writeFileSync(new URL('./page.html', import.meta.url).pathname, page.html);
writeFileSync(new URL('./network-log.json', import.meta.url).pathname, JSON.stringify(networkLog, null, 2));

// ── Build a minimal HAR 1.2 log ──────────────────────────────────
const har = {
  log: {
    version: '1.2',
    creator: { name: 'kenkage-diagnose', version: '0.0.1' },
    entries: networkLog.map((entry) => ({
      startedDateTime: new Date().toISOString(),
      time: entry.durationMs,
      request: { method: entry.method, url: entry.url, httpVersion: 'HTTP/1.1', headers: [], queryString: [], headersSize: -1, bodySize: -1 },
      response: {
        status: entry.status ?? 0,
        statusText: entry.ok ? 'OK' : (entry.error ?? 'Error'),
        httpVersion: 'HTTP/1.1',
        headers: [],
        content: { size: entry.bodySize ?? 0, mimeType: 'text/plain' },
        redirectURL: '',
        headersSize: -1,
        bodySize: entry.bodySize ?? -1,
      },
      cache: {},
      timings: { send: 0, wait: entry.durationMs, receive: 0 },
    })),
  },
};

const harPath = new URL('./yc-companies.har', import.meta.url).pathname;
writeFileSync(harPath, JSON.stringify(har, null, 2));

console.log('=== SUMMARY ===');
console.log('status:', page.status);
console.log('title:', page.title);
console.log('scriptsExecuted:', page.scriptsExecuted);
console.log('scriptsSkipped:', JSON.stringify(page.scriptsSkipped, null, 2));
console.log('scriptErrors:', JSON.stringify(page.scriptErrors, null, 2));
console.log('uncaughtErrors:', JSON.stringify(page.uncaughtErrors, null, 2));
console.log('consoleMessages:', JSON.stringify(page.consoleMessages, null, 2));
console.log('networkLog (' + networkLog.length + ' requests):');
console.log(JSON.stringify(networkLog, null, 2));
console.log('HAR written to:', harPath);
console.log('text length:', page.text.length);
console.log('text preview:', page.text.slice(0, 500));
