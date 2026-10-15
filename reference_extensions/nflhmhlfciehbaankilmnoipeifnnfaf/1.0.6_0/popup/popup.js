'use strict';

const KEY = 'morph:recipes';
const ONBOARD_KEY = 'morph:onboarded';

const $ = (id) => document.getElementById(id);

function getAll() {
  return new Promise((r) => chrome.storage.local.get(KEY, (d) => r((d && d[KEY]) || {})));
}
function setAll(map) {
  return new Promise((r) => chrome.storage.local.set({ [KEY]: map }, r));
}
function getFlag(key) {
  return new Promise((r) => chrome.storage.local.get(key, (d) => r(d && d[key])));
}
function setFlag(key, val) {
  return new Promise((r) => chrome.storage.local.set({ [key]: val }, r));
}
function activeTab() {
  return new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => r(t[0])));
}
function originOf(url) { try { return new URL(url).origin; } catch { return null; } }
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toast(msg, kind) {
  const t = $('ioToast');
  if (!t) return;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg || '';
  if (msg) {
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.textContent = ''; t.className = 'toast'; }, 4000);
  }
}

function recipeCard(recipe, { showOrigin }) {
  const div = document.createElement('div');
  const off = recipe.enabled === false;
  div.className = 'recipe' + (off ? ' disabled' : '');
  const when = recipe.createdAt ? new Date(recipe.createdAt).toLocaleDateString() : '';
  div.innerHTML =
    `<div class="q">“${esc(recipe.prompt)}”</div>` +
    `<div class="meta">${showOrigin ? esc(recipe.origin) + ' · ' : ''}${esc(when)}` +
      `${recipe.stale ? ' · <span class="stale">stale</span>' : ''}` +
      `${off ? ' · <span class="badge-off">disabled</span>' : ''}</div>` +
    `<div class="ctl">` +
      `<button class="ghost toggle">${off ? 'Enable' : 'Disable'}</button>` +
      `<button class="ghost open">Open site</button>` +
      `<button class="danger del">Delete</button>` +
    `</div>`;
  div.querySelector('.toggle').addEventListener('click', async () => {
    const all = await getAll();
    if (all[recipe.origin]) { all[recipe.origin].enabled = recipe.enabled === false; await setAll(all); render(); }
  });
  div.querySelector('.open').addEventListener('click', () => {
    if (recipe.origin && /^https?:\/\//.test(recipe.origin)) chrome.tabs.create({ url: recipe.origin });
  });
  div.querySelector('.del').addEventListener('click', async () => {
    const all = await getAll();
    delete all[recipe.origin]; await setAll(all); render();
  });
  return div;
}

async function render() {
  const tab = await activeTab();
  const origin = tab ? originOf(tab.url) : null;
  $('origin').textContent = origin || 'no active page';

  const all = await getAll();
  const items = Object.values(all).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // recipe count
  const countEl = $('recipeCount');
  if (countEl) countEl.textContent = items.length ? String(items.length) : '';

  // current site
  const cur = $('current'); cur.innerHTML = '';
  if (origin && all[origin]) cur.appendChild(recipeCard(all[origin], { showOrigin: false }));
  else cur.innerHTML = '<div class="empty">No recipe yet. Open Morph and describe a change.</div>';

  // all recipes
  const list = $('list'); list.innerHTML = '';
  if (!items.length) list.innerHTML = '<div class="empty">Nothing saved yet.</div>';
  else items.forEach((r) => list.appendChild(recipeCard(r, { showOrigin: true })));

  // first-run onboarding: only when there are no recipes and the flag is unset
  const onboarded = await getFlag(ONBOARD_KEY);
  const onboardSection = $('onboardSection');
  if (onboardSection) onboardSection.hidden = !(items.length === 0 && !onboarded);

  // account/sign-in state (independent of recipes; never blocks render)
  renderAuth();
}

$('openBar').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'morph:open-active' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      const btn = $('openBar');
      btn.textContent = "Can't run on this page — open a normal website";
      btn.disabled = true;
      return;
    }
    window.close();
  });
});

// --- account / Google sign-in -------------------------------------------------
// The background service worker owns auth (chrome.identity). The popup just asks it
// for status and triggers an interactive sign-in. Reshaping itself never needs an
// account (it uses an anonymous app-token); signing in unlocks app connectors and
// lets us count distinct users. If the worker can't be reached (e.g. it failed to
// register), we treat sign-in as unavailable and hide the section rather than show a
// dead button.
function sendBg(type) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type }, (resp) => {
        if (chrome.runtime.lastError || !resp) return resolve(null);
        resolve(resp);
      });
    } catch (_) { resolve(null); }
  });
}

async function renderAuth() {
  const section = $('authSection');
  const box = $('authBox');
  if (!section || !box) return;
  const st = await sendBg('morph:authstatus');
  // Not reachable, or OAuth not configured -> sign-in unavailable; keep it hidden.
  if (!st || !st.configured) { section.hidden = true; return; }
  section.hidden = false;

  if (st.signedIn) {
    box.innerHTML =
      `<div class="status-line"><span class="dot online"></span>Signed in${st.email ? ' · ' + esc(st.email) : ''}</div>`;
    return;
  }

  box.innerHTML =
    `<button class="primary" id="signinBtn">Sign in with Google</button>` +
    `<div class="hint" id="authHint">Optional — reshaping works without an account. Sign in to connect apps (Gmail, GitHub, Notion…) and pull your own data into a reshape.</div>`;
  $('signinBtn').addEventListener('click', async () => {
    const btn = $('signinBtn');
    const hint = $('authHint');
    btn.disabled = true;
    btn.textContent = 'Opening Google…';
    const resp = await sendBg('morph:signin');
    if (resp && resp.ok && resp.signedIn) {
      box.innerHTML =
        `<div class="status-line"><span class="dot online"></span>Signed in${resp.email ? ' · ' + esc(resp.email) : ''}</div>`;
    } else {
      btn.disabled = false;
      btn.textContent = 'Sign in with Google';
      if (hint) {
        hint.textContent = resp && resp.notConfigured
          ? 'Sign-in is not configured for this build yet.'
          : 'Sign-in failed or was cancelled. Try again.';
        hint.style.color = '#ff8a8a';
      }
    }
  });
}

// --- onboarding dismiss ---
$('onboardDismiss').addEventListener('click', async () => {
  await setFlag(ONBOARD_KEY, true);
  const s = $('onboardSection');
  if (s) s.hidden = true;
});

// (Backend URL/status UI intentionally hidden from end users — the hosted API is the
// default and is configured in the background service worker, not exposed in the popup.)

// --- export ---

$('exportBtn').addEventListener('click', async () => {
  try {
    const all = await getAll();
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'morph-recipes.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported ' + Object.keys(all).length + ' recipe(s).', 'ok');
  } catch (_) {
    toast('Export failed.', 'err');
  }
});

// --- import ---
//
// Validate strictly: accept an origin->recipe object map; keep only entries that have
// origin/prompt/transform; coerce enabled (default true) and stale (default false).
// Imported entries overwrite same-origin recipes after a confirm. Never eval; never
// innerHTML untrusted text (recipeCard escapes via esc()).
function normalizeImported(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [origin, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const o = typeof val.origin === 'string' ? val.origin : origin;
    if (typeof o !== 'string' || !o) continue;
    if (typeof val.prompt !== 'string') continue;
    if (!val.transform || typeof val.transform !== 'object') continue;
    out[o] = {
      origin: o,
      prompt: val.prompt,
      transform: val.transform,
      enabled: val.enabled === false ? false : true,
      stale: val.stale === true,
      createdAt: typeof val.createdAt === 'number' ? val.createdAt : Date.now(),
    };
  }
  return out;
}

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-importing the same file later
  if (!file) return;
  let text;
  try { text = await file.text(); }
  catch { toast('Could not read file.', 'err'); return; }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { toast('Not valid JSON.', 'err'); return; }

  const imported = normalizeImported(parsed);
  const count = Object.keys(imported).length;
  if (!count) { toast('No valid recipes found in that file.', 'err'); return; }

  const existing = await getAll();
  const overlaps = Object.keys(imported).filter((o) => existing[o]).length;
  if (overlaps) {
    const ok = confirm(
      `Import ${count} recipe(s)? ${overlaps} will overwrite an existing recipe for the same site.`
    );
    if (!ok) { toast('Import cancelled.', ''); return; }
  }

  const merged = Object.assign({}, existing, imported);
  await setAll(merged);
  render();
  toast('Imported ' + count + ' recipe(s).', 'ok');
});

render();
