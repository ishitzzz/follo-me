/*
 * Background service worker (MV3).
 *  - Relays {prompt, context, url} to the Morph backend and returns the transform.
 *  - Toggles the prompt bar, injecting the content scripts on demand if a tab predates
 *    the install (so it works without reloading the page).
 */

const DEFAULT_BACKEND = 'https://morph-api-234584917638.us-central1.run.app/api/transform';
const BACKEND_KEY = 'morph:backendUrl';
const INSTALL_KEY = 'morph:installId';
const APPTOKEN_KEY = 'morph:appToken';

// On-demand injection runs once (run_at distinction is moot here), but early.js
// must run AFTER recipes.js is defined, so it goes right after recipes.js.
const CONTENT_FILES = [
  'src/dsl.js',
  'src/context.js',
  'src/recipes.js',
  'src/connectors.js',
  'src/picker.js',
  'src/early.js',
  'src/promptbar.js',
  'src/content.js',
];

async function backendUrl() {
  try {
    const data = await chrome.storage.local.get(BACKEND_KEY);
    return (data && data[BACKEND_KEY]) || DEFAULT_BACKEND;
  } catch (_) {
    return DEFAULT_BACKEND;
  }
}

// --- Google sign-in (GCP OAuth) -------------------------------------------
// Uses chrome.identity.getAuthToken against the manifest's oauth2 client. The
// token is sent as Authorization: Bearer to the backend, which verifies it via
// Google userinfo. No-ops cleanly until the OAuth client id is configured.
const OAUTH_PLACEHOLDER = 'REPLACE_WITH_OAUTH_CLIENT_ID';

function oauthConfigured() {
  try {
    const cid = (chrome.runtime.getManifest().oauth2 || {}).client_id || '';
    return cid && cid.indexOf(OAUTH_PLACEHOLDER) === -1;
  } catch (_) { return false; }
}

function getToken(interactive) {
  return new Promise((resolve) => {
    if (!oauthConfigured() || !chrome.identity || !chrome.identity.getAuthToken) return resolve(null);
    try {
      chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
        if (chrome.runtime.lastError || !token) return resolve(null);
        resolve(token);
      });
    } catch (_) { resolve(null); }
  });
}

// POST the Google token to the backend so it records a privacy-safe user event
// (one-way sub hash + email domain) for counting users. Best-effort; returns
// { ok, email } or null.
async function recordSignin(token) {
  try {
    const endpoint = await backendUrl();
    const base = endpoint.replace(/\/api\/transform\/?$/, '');
    const resp = await fetch(base + '/api/signin', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    const d = await resp.json().catch(() => null);
    return d && d.ok ? d : null;
  } catch (_) { return null; }
}

async function signIn() {
  if (!oauthConfigured()) return { ok: false, signedIn: false, notConfigured: true };
  const token = await getToken(true);
  if (!token) return { ok: false, signedIn: false };
  let email = '';
  try { const info = await recordSignin(token); email = (info && info.email) || ''; } catch (_) {}
  return { ok: true, signedIn: true, email };
}

// Connect an app via Composio Hosted Auth (one key, managed OAuth for 250+ apps).
// publicData apps (GitHub) need no auth. Returns { ok, pending? } — the user finishes
// in the opened tab; the backend confirms the connection live on each request.
async function connectApp(app) {
  if (!app || typeof app !== 'object') return { ok: false, error: 'bad app' };
  if (app.publicData) return { ok: true };           // e.g. GitHub public API — no auth
  // Connecting an app exposes the user's PRIVATE data, so the backend keys it off a
  // verified Google identity. Sign-in is required (interactive — this is an explicit
  // user action, so prompting here is expected).
  const token = await getToken(true);
  if (!token) return { ok: false, error: 'signin_required', needSignin: true };
  const endpoint = await backendUrl();
  const base = endpoint.replace(/\/api\/transform\/?$/, '');
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
  let initR = null;
  try {
    const resp = await fetch(base + '/api/connect/initiate', {
      method: 'POST', headers, body: JSON.stringify({ app: app.id }),
    });
    initR = await resp.json().catch(() => null);
  } catch (_) { return { ok: false, error: 'network' }; }
  if (!initR || !initR.ok || !initR.redirectUrl) {
    return { ok: false, error: (initR && initR.error) || 'initiate_failed' };
  }
  try { await chrome.tabs.create({ url: initR.redirectUrl }); } catch (_) {}
  return { ok: true, pending: true };                 // user authorizes in the opened tab
}

// Authoritative connection check (Composio, via backend). Returns { connected }.
async function connectStatus(appId) {
  if (!appId) return { connected: false };
  // Connection status reads a verified-Google-keyed record; if not signed in the
  // user definitively has no private connection. Silent (non-interactive) token.
  const token = await getToken(false);
  if (!token) return { connected: false };
  const endpoint = await backendUrl();
  const base = endpoint.replace(/\/api\/transform\/?$/, '');
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
  try {
    const resp = await fetch(base + '/api/connect/status', { method: 'POST', headers, body: JSON.stringify({ app: appId }) });
    const d = await resp.json().catch(() => null);
    return { connected: !!(d && d.connected) };
  } catch (_) { return { connected: false }; }
}

// --- app-token auth (transparent; no sign-in) -----------------------------
async function getInstallId() {
  const d = await chrome.storage.local.get(INSTALL_KEY);
  let id = d && d[INSTALL_KEY];
  if (!id) {
    id = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID()
      : 'm-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    await chrome.storage.local.set({ [INSTALL_KEY]: id });
  }
  return id;
}

function tokenEndpoint(transformUrl) {
  return transformUrl.replace(/\/api\/transform\/?$/, '/api/token');
}

async function getAppToken(forceRefresh) {
  try {
    if (!forceRefresh) {
      const d = await chrome.storage.local.get(APPTOKEN_KEY);
      const c = d && d[APPTOKEN_KEY];
      if (c && c.token && c.exp && c.exp - Date.now() > 60000) return c.token;
    }
    const endpoint = await backendUrl();
    const installId = await getInstallId();
    const resp = await fetch(tokenEndpoint(endpoint), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId }),
    });
    const data = await resp.json().catch(() => null);
    if (data && data.ok && data.token) {
      await chrome.storage.local.set({ [APPTOKEN_KEY]: { token: data.token, exp: data.exp } });
      return data.token;
    }
  } catch (_) { /* offline / not configured */ }
  return null;
}

async function requestTransform({ prompt, context, url, app, target }) {
  const endpoint = await backendUrl();
  const body = JSON.stringify({ prompt, context, url, app, target });
  const callWith = async (token) => {
    const headers = { 'Content-Type': 'application/json', 'X-Morph-Client': 'ext' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(endpoint, { method: 'POST', headers, body });
  };

  // Connector data enrichment requires a VERIFIED Google identity (the backend
  // ignores the forgeable app token for private data). So when an app connector is
  // in play, send the Google token if the user is signed in; otherwise the app
  // token is the transparent anonymous-reshape gate (reshape still works, just no
  // connector data).
  const googleToken = app ? await getToken(false) : null;
  let token = googleToken || await getAppToken(false);
  let resp = await callWith(token);
  if (resp.status === 401 && !googleToken) {   // only the app-token path can refresh-and-retry
    token = await getAppToken(true);
    resp = await callWith(token);
  }
  if (resp.status === 401) return { ok: false, error: 'auth_required', authRequired: true };

  const data = await resp.json().catch(() => ({ ok: false, error: 'bad response from backend' }));
  if (!resp.ok && data && !data.error) data.error = 'backend error ' + resp.status;
  return data;
}

// Fire-and-forget capture relay: forwards a kept/undone signal to /api/event.
// Never blocks; failures are swallowed (telemetry is best-effort).
function sendEvent(payload) {
  (async () => {
    try {
      const endpoint = await backendUrl();
      const base = endpoint.replace(/\/api\/transform\/?$/, '');
      const token = await getAppToken(false);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      await fetch(base + '/api/event', { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (_) { /* best-effort */ }
  })();
}

function ping(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'morph:ping' }, (resp) => {
      resolve(!chrome.runtime.lastError && resp && resp.pong === true);
    });
  });
}

function inject(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

// Ensure the content script is present, then toggle the bar. Works on tabs opened
// before install. Returns false if the page is restricted (chrome://, web store, etc.).
async function openHere(tab) {
  if (!tab || tab.id == null) return false;
  const url = tab.url || '';
  if (/^(chrome|edge|brave|about|chrome-extension|devtools|view-source):/i.test(url) ||
      url.startsWith('https://chrome.google.com/webstore') ||
      url.startsWith('https://chromewebstore.google.com')) {
    return false;
  }
  let alive = await ping(tab.id);
  if (!alive) { const ok = await inject(tab.id); if (!ok) return false; alive = true; }
  chrome.tabs.sendMessage(tab.id, { type: 'morph:toggle' }, () => void chrome.runtime.lastError);
  return true;
}

// Accept only messages from this same extension (popup / our content scripts).
// Content scripts of the same extension carry the extension id; web pages do not.
function fromSelf(sender) {
  return !!(sender && (sender.id === undefined || sender.id === chrome.runtime.id));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore anything that is not a well-formed { type: string } message.
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'morph:transform') {
    if (!fromSelf(sender)) return undefined; // ignore foreign senders
    const p = msg.payload;
    if (!p || typeof p !== 'object' || typeof p.prompt !== 'string' ||
        (p.context !== undefined && typeof p.context !== 'string') ||
        (p.url !== undefined && typeof p.url !== 'string') ||
        (p.app !== undefined && typeof p.app !== 'string') ||
        (p.target !== undefined && (typeof p.target !== 'object' || p.target === null))) {
      sendResponse({ ok: false, error: 'bad request' });
      return undefined;
    }
    requestTransform({ prompt: p.prompt, context: p.context, url: p.url, app: p.app, target: p.target })
      .then((data) => sendResponse(data))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async
  }

  if (msg.type === 'morph:open-active') {
    if (!fromSelf(sender)) return undefined; // ignore foreign senders
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const ok = await openHere(tabs[0]);
      sendResponse({ ok });
    });
    return true; // async
  }

  if (msg.type === 'morph:signin') {
    if (!fromSelf(sender)) return undefined;
    signIn().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true; // async
  }

  if (msg.type === 'morph:authstatus') {
    if (!fromSelf(sender)) return undefined;
    getToken(false).then((t) => sendResponse({ signedIn: !!t, configured: oauthConfigured() }))
      .catch(() => sendResponse({ signedIn: false, configured: oauthConfigured() }));
    return true; // async
  }

  if (msg.type === 'morph:connect') {
    if (!fromSelf(sender)) return undefined;
    connectApp(msg.app).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async
  }

  if (msg.type === 'morph:connectstatus') {
    if (!fromSelf(sender)) return undefined;
    connectStatus(msg.app).then(sendResponse).catch(() => sendResponse({ connected: false }));
    return true; // async
  }

  if (msg.type === 'morph:event') {
    if (!fromSelf(sender)) return undefined;
    if (typeof msg.kind === 'string') {
      sendEvent({
        kind: msg.kind,
        url: typeof msg.url === 'string' ? msg.url : '',
        prompt: typeof msg.prompt === 'string' ? msg.prompt : '',
      });
    }
    return undefined; // fire-and-forget; no response
  }

  return undefined; // unknown type -> ignore (no response)
});

// On first install, open the welcome page to invite Google sign-in (skippable).
chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === 'install') {
    try { chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }); } catch (_) { /* noop */ }
  }
});

chrome.action.onClicked.addListener((tab) => { openHere(tab); }); // fires only if no popup
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-morph') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => openHere(tabs[0]));
  }
});
