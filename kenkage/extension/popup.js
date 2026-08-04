const toggle = document.getElementById('enabledToggle');
const activityEl = document.getElementById('activity');

async function renderActivity() {
  const { activity = [] } = await chrome.storage.local.get('activity');
  if (activity.length === 0) {
    activityEl.innerHTML = '<div class="empty">No requests yet.</div>';
    return;
  }
  activityEl.innerHTML = activity
    .map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString();
      const statusClass = entry.ok ? 'ok' : 'fail';
      const statusText = entry.ok ? 'OK ' + entry.status : 'FAILED';
      return (
        '<div class="entry"><span class="url">' +
        escapeHtml(entry.url) +
        '</span><span class="meta"><span class="' +
        statusClass +
        '">' +
        statusText +
        '</span> · ' +
        time +
        (entry.error ? ' · ' + escapeHtml(entry.error) : '') +
        '</span></div>'
      );
    })
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function init() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  toggle.checked = enabled;
  await renderActivity();
}

toggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: toggle.checked });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.activity) renderActivity();
});

init();
