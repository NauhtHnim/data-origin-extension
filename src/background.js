// Toolbar click (or Alt+Shift+D) toggles pick mode in the page.
// Returns false when the page was loaded before the extension and needs a reload.
function toggleInPage() {
  if (!window.__dataOrigin) return false;
  window.__dataOrigin.toggle();
  return true;
}

function flashBadge(tabId, text, title) {
  chrome.action.setBadgeBackgroundColor({ color: '#d29922' });
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setTitle({ tabId, title });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: toggleInPage });
    if (!res || res.result !== true) flashBadge(tab.id, '↻', 'Data Origin: reload this page first, so requests are captured');
  } catch (e) {
    // Browser pages (chrome://, brave://, the extension store) cannot be scripted.
    flashBadge(tab.id, '✕', 'Data Origin cannot run on this page');
  }
});
