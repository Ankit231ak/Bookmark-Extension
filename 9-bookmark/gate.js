// Black lock screen for sites that live in a locked board.
const params = new URLSearchParams(location.search);
const target = params.get('to') || '';
const domain = (params.get('domain') || '').toLowerCase();

const pass = document.getElementById('pass');
const errorEl = document.getElementById('error');

// Show which site is being gated.
let host = domain;
try { host = new URL(target).hostname; } catch { /* keep domain */ }
document.getElementById('siteName').textContent = host || domain || 'This site';

// Add the domain to this session's unlocked set (clears when the browser closes).
async function unlockDomain() {
  const { unlockedDomains = [] } = await chrome.storage.session.get('unlockedDomains');
  if (!unlockedDomains.includes(domain)) unlockedDomains.push(domain);
  await chrome.storage.session.set({ unlockedDomains });
}

document.getElementById('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = pass.value.trim();
  const { settings } = await chrome.storage.local.get('settings');
  const master = settings?.masterPassword || '';
  const recovery = settings?.recoveryPassword || '';
  if (value && (value === master || value === recovery)) {
    await unlockDomain();
    location.replace(target || chrome.runtime.getURL('newtab.html'));
  } else {
    errorEl.textContent = 'Incorrect password. Try again.';
    pass.value = '';
    pass.focus();
  }
});

document.getElementById('cancel').addEventListener('click', () => {
  location.replace(chrome.runtime.getURL('newtab.html'));
});

pass.focus();
