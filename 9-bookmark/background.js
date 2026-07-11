// 9 Bookmark background service worker

const QUICK_SAVE_LIMIT = 40;

function notify(title, message) {
  chrome.notifications.create('', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('logo.png'),
    title,
    message
  }, () => {
    if (chrome.runtime.lastError) console.warn('9 Bookmark notification failed:', chrome.runtime.lastError.message);
  });
}

// Returns 'saved' | 'duplicate' | 'invalid'.
async function saveQuick(title, url) {
  if (!url || /^(chrome|chrome-extension|edge|about):/i.test(url)) return 'invalid';
  const { quickSaves = [], workspace } = await chrome.storage.local.get(['quickSaves', 'workspace']);
  // The Home tab is the first page; quick saves are merged into it when the dashboard opens.
  const home = workspace?.pages?.[0];
  const inHome = home?.boards?.some((b) => b.links?.some((l) => l[1] === url));
  if (inHome || quickSaves.some((item) => item.url === url)) return 'duplicate';
  quickSaves.unshift({ id: crypto.randomUUID(), title: (title || url).trim(), url });
  await chrome.storage.local.set({ quickSaves: quickSaves.slice(0, QUICK_SAVE_LIMIT) });
  return 'saved';
}

function reportSave(status, name) {
  const label = name && name.length > 48 ? `${name.slice(0, 47)}…` : name;
  if (status === 'saved') notify('9 Bookmark', `Saved “${label}” to your Home tab`);
  else if (status === 'duplicate') notify('9 Bookmark', `“${label}” is already in your Home tab`);
  else notify('9 Bookmark', 'This page can’t be saved');
}

// Injected into the active page to show a small top-right popup (no persistent content script).
function pagePopup(message, kind) {
  const ID = '__ninebookmark_popup__';
  document.getElementById(ID)?.remove();
  const accent = kind === 'saved' ? '#00e98a' : kind === 'duplicate' ? '#ffc655' : '#ff7b91';
  const box = document.createElement('div');
  box.id = ID;
  box.style.cssText = 'position:fixed;top:18px;right:18px;z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:330px;padding:13px 16px;border-radius:12px;border:1px solid rgba(158,181,198,.28);background:#182434;color:#e9f0f4;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 18px 44px rgba(0,0,0,.45);opacity:0;transform:translateY(-10px);transition:opacity .25s ease,transform .25s ease';
  const dot = document.createElement('span');
  dot.style.cssText = 'flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:' + accent + ';box-shadow:0 0 10px ' + accent;
  const text = document.createElement('span');
  text.textContent = message;
  box.appendChild(dot);
  box.appendChild(text);
  (document.body || document.documentElement).appendChild(box);
  requestAnimationFrame(() => { box.style.opacity = '1'; box.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    box.style.opacity = '0';
    box.style.transform = 'translateY(-10px)';
    setTimeout(() => box.remove(), 320);
  }, 3200);
}

// Show the popup on the given tab; returns true on success (fails on restricted pages).
async function showOnPage(tabId, message, kind) {
  if (tabId == null) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pagePopup, args: [message, kind] });
    return true;
  } catch (err) {
    console.warn('9 Bookmark popup failed:', err?.message);
    return false;
  }
}

function popupMessage(status) {
  if (status === 'saved') return 'Saved to your Home tab';
  if (status === 'duplicate') return 'This bookmark is already in Home tab';
  return 'This page can’t be saved';
}

// --- Locked-site blocking ---------------------------------------------------

// Lowercase a hostname and drop a leading "www." so subdomains match cleanly.
function baseHost(host) {
  return host.replace(/^www\./i, '').toLowerCase();
}

// Cache of blocked domains; invalidated whenever the workspace changes.
let domainCache = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.workspace) domainCache = null;
});

// Set of base domains that belong to locked boards (blocked browser-wide).
async function blockedDomains() {
  if (domainCache) return domainCache;
  const { workspace } = await chrome.storage.local.get('workspace');
  const set = new Set();
  workspace?.pages?.forEach((p) => p.boards?.forEach((b) => {
    if (!b.locked) return;
    b.links?.forEach((l) => {
      try { set.add(baseHost(new URL(l[1]).hostname)); } catch { /* skip bad url */ }
    });
  }));
  domainCache = set;
  return set;
}

// Domains temporarily unlocked for this browser session (clears on restart).
async function sessionUnlocked() {
  const { unlockedDomains = [] } = await chrome.storage.session.get('unlockedDomains');
  return new Set(unlockedDomains);
}

// Return the blocked base domain that navHost belongs to, or null.
function matchBlocked(navHost, domains) {
  for (const d of domains) {
    if (navHost === d || navHost.endsWith('.' + d)) return d;
  }
  return null;
}

// Build the URL of the black gate page for a target navigation.
function gateUrl(target, domain) {
  return chrome.runtime.getURL('gate.html')
    + `?to=${encodeURIComponent(target)}&domain=${encodeURIComponent(domain)}`;
}

// Redirect navigations to locked domains to the password gate.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // top-level frame only
  let url;
  try { url = new URL(details.url); } catch { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const domains = await blockedDomains();
  if (!domains.size) return;
  const match = matchBlocked(baseHost(url.hostname), domains);
  if (!match) return;
  const unlocked = await sessionUnlocked();
  if (unlocked.has(match)) return;
  chrome.tabs.update(details.tabId, { url: gateUrl(details.url, match) });
});

// Clear session unlocks and re-gate any open tab sitting on a locked domain.
async function relockSites() {
  await chrome.storage.session.set({ unlockedDomains: [] });
  const domains = await blockedDomains();
  if (!domains.size) {
    notify('9 Bookmark', 'No locked sites to lock');
    return;
  }
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!tab.url || tab.id == null) continue;
    let host;
    try { host = baseHost(new URL(tab.url).hostname); } catch { continue; }
    const match = matchBlocked(host, domains);
    if (match) chrome.tabs.update(tab.id, { url: gateUrl(tab.url, match) });
  }
  notify('9 Bookmark', 'Locked sites are locked again');
}

// Keyboard commands.
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'lock-sites') return relockSites();
  if (command !== 'quick-save') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = await saveQuick(tab?.title, tab?.url);
  const shown = await showOnPage(tab?.id, popupMessage(status), status);
  if (!shown) reportSave(status, (tab?.title || tab?.url || 'page').trim());
});

// Right-click "Save to 9 Bookmark" on any page, link, or selection.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-to-9bookmark',
    title: 'Save to 9 Bookmark',
    contexts: ['page', 'link', 'selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-to-9bookmark') return;
  const url = info.linkUrl || info.pageUrl || tab?.url;
  const title = info.linkUrl ? (info.selectionText || url) : (tab?.title || url);
  const status = await saveQuick(title, url);
  const shown = await showOnPage(tab?.id, popupMessage(status), status);
  if (!shown) reportSave(status, (title || 'page').trim());
});
