// Kenkage Network Bridge — content script.
//
// Bridges window.postMessage (page context) to chrome.runtime.sendMessage
// (extension context, where the actual unrestricted fetch happens in
// background.js). Only relays the specific KBOOK_BRIDGE_FETCH_REQUEST shape;
// everything else is ignored.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== 'KBOOK_BRIDGE_FETCH_REQUEST') return;

  chrome.runtime.sendMessage(
    { type: 'KBOOK_BRIDGE_FETCH', url: data.url, method: data.method },
    (response) => {
      window.postMessage(
        { type: 'KBOOK_BRIDGE_FETCH_RESPONSE', id: data.id, response: response || { error: 'No response from extension' } },
        '*'
      );
    }
  );
});

// Lets page code feature-detect the bridge without a round trip:
// `document.documentElement.dataset.kbookBridge === 'true'`.
document.documentElement.dataset.kbookBridge = 'true';
