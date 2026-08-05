import { createKenkage } from 'kenkage';

const TARGET_URL = process.argv[2] ?? 'https://www.ycombinator.com/companies';

const engine = await createKenkage({ engine: 'full' });
await engine.init();

const PROBE = `<script>
(function(){
  const origCreate = document.createElement.bind(document);
  let count = 0;
  const tagCounts = {};
  document.createElement = function(tag) {
    count++;
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    if (count <= 60) console.log('createElement #' + count + ': ' + tag);
    return origCreate(tag);
  };
  const realProto = Object.getPrototypeOf(document.body);
  console.log('realProto === Node.prototype: ' + (realProto === Node.prototype));
  const origAppend = realProto.appendChild;
  let appendCount = 0;
  realProto.appendChild = function(child) {
    appendCount++;
    if (appendCount <= 10) console.log('appendChild #' + appendCount + ' onto <' + this.tagName + '> child=<' + (child && child.tagName) + '>');
    return origAppend.call(this, child);
  };
  // React-DOM's host config calls insertBefore(child, null) for appends,
  // not appendChild — a real browser comparison run showed totalAppend=0
  // even on a page that DOES render, confirming this is the method to watch.
  const origInsertBefore = realProto.insertBefore;
  let insertBeforeCount = 0;
  const insertTargets = {};
  realProto.insertBefore = function(child, ref) {
    insertBeforeCount++;
    const key = this.tagName + '<-' + (child && child.tagName);
    insertTargets[key] = (insertTargets[key] || 0) + 1;
    if (insertBeforeCount <= 10) console.log('insertBefore #' + insertBeforeCount + ' onto <' + this.tagName + '> child=<' + (child && child.tagName) + '> ref=' + (ref ? ('<' + ref.tagName + '>') : 'null'));
    return origInsertBefore.call(this, child, ref);
  };
  window.__probeInsert = () => JSON.stringify({ insertBeforeCount, insertTargets });
  window.__probeCounts = () => JSON.stringify({ tagCounts, totalCreate: count, totalAppend: appendCount });
  const origGetById = document.getElementById.bind(document);
  const getByIdCalls = [];
  document.getElementById = function(id) {
    const el = origGetById(id);
    getByIdCalls.push({ id, found: !!el });
    return el;
  };
  window.__probeGetById = () => JSON.stringify(getByIdCalls);
  const origQS = document.querySelector.bind(document);
  const qsCalls = [];
  document.querySelector = function(sel) {
    const el = origQS(sel);
    if (qsCalls.length < 30) qsCalls.push({ sel, found: !!el });
    return el;
  };
  window.__probeQS = () => JSON.stringify(qsCalls);
  // Catch errors at the moment they're CONSTRUCTED, not when (if ever)
  // something logs or rethrows them — react_on_rails is documented to
  // swallow render errors entirely by default (raise_on_prerender_error:
  // false), so waiting for console.error or an uncaught rejection won't
  // see anything it already ate.
  const seenErrors = [];
  for (const ctorName of ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError']) {
    const orig = globalThis[ctorName];
    if (!orig) continue;
    globalThis[ctorName] = new Proxy(orig, {
      construct(target, args) {
        const err = Reflect.construct(target, args);
        const msg = String(args[0] ?? '');
        // Skip Sentry's own debug-id boilerplate (new Error().stack with no
        // message, called from a module's very first top-level statement)
        if (msg !== '') seenErrors.push({ ctor: ctorName, message: msg, stack: err.stack });
        return err;
      },
    });
  }
  window.__probeErrors = () => JSON.stringify(seenErrors);
  window.addEventListener('error', (e) => console.log('window error event: ' + (e.message || e)));
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    console.log('FETCH CALLED: ' + args[0]);
    return origFetch.apply(this, args);
  };
})();
</script>`;

async function trackedFetch(url) {
  const res = await engine.fetch(url);
  if (url === TARGET_URL) {
    const body = res.body.replace('<head>', '<head>' + PROBE);
    return { status: res.status, body };
  }
  return res;
}

const page = await engine.loadPage(TARGET_URL, { fetchFn: trackedFetch });

console.log('=== consoleMessages ===');
console.log(JSON.stringify(page.consoleMessages, null, 2));
console.log('=== uncaughtErrors ===');
console.log(JSON.stringify(page.uncaughtErrors, null, 2));
console.log('=== scriptErrors ===');
console.log(JSON.stringify(page.scriptErrors, null, 2));
console.log('nodeCount:', engine.getNodeCount());
const counts = await engine.eval('window.__probeCounts()');
console.log('=== probe counts ===');
console.log(counts.result);
const byId = await engine.eval('window.__probeGetById()');
console.log('=== getElementById calls ===');
console.log(byId.result);
const qs = await engine.eval('window.__probeQS()');
console.log('=== querySelector calls (first 30) ===');
console.log(qs.result);

const insertData = await engine.eval('window.__probeInsert()');
console.log('=== insertBefore activity ===');
console.log(insertData.result);

const errs = await engine.eval('window.__probeErrors()');
console.log('=== ALL Error() constructions (even ones later caught/swallowed) ===');
console.log(errs.result);

console.log('=== extra settle rounds ===');
for (let i = 0; i < 10; i++) {
  const settleResult = await engine.settle();
  console.log(`round ${i}: nodeCount=${engine.getNodeCount()} uncaughtErrors=${settleResult.uncaughtErrors.length} consoleMessages=${settleResult.consoleMessages.length}`);
  if (settleResult.consoleMessages.length) console.log(JSON.stringify(settleResult.consoleMessages));
  if (settleResult.uncaughtErrors.length) console.log(JSON.stringify(settleResult.uncaughtErrors));
}
console.log('FINAL text:', engine.getText().slice(0, 200));
const finalCounts = await engine.eval('window.__probeCounts()');
console.log('FINAL probe counts:', finalCounts.result);

engine.destroy();
