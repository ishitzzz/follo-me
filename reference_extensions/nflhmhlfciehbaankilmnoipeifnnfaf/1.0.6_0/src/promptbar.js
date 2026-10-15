/*
 * Prompt bar — the universal, style-isolated overlay (Shadow DOM) shown on every site.
 * Pure UI: it knows nothing about the model or recipes; content.js wires the handlers.
 * Attaches to window.Morph.bar.
 *
 * Public contract consumed by content.js (DO NOT remove/rename or change semantics):
 *   mount(handlers {onSubmit, onUndo}), show, hide, toggle, isVisible,
 *   setStatus(text, kind), clearStatus, setBusy(bool), showActions(bool), clearInput.
 * A few NON-breaking helpers are added below (focusInput, setRecent).
 */
(function () {
  'use strict';
  window.Morph = window.Morph || {};

  const HOST_ID = 'morph-host-root';
  // Recent prompts are stored PER-ORIGIN: a map { origin -> string[] } under one key,
  // so the bar only ever shows prompts you typed on the site you're currently on.
  const RECENT_KEY = 'morph:recentByOrigin';
  const LEGACY_RECENT_KEY = 'morph:recentPrompts'; // pre-1.0.5 global list; removed on mount
  const RECENT_CAP = 6;       // prompts kept per origin
  const MAX_ORIGINS = 60;     // bound total storage growth

  let host, root, els, handlers = {}, visible = false;
  let lastFocused = null;       // page element focused before show(), restored on hide()
  let recipeActive = false;     // when a recipe is active we keep example chips hidden
  let connectHandler = null;    // onConnect callback for the connector suggestion
  let currentSuggestions = [];  // site-special model prompts (via setSuggestions); empty hides the row
  let targetClear = null;       // onClear callback for the targeted-element indicator

  const CSS = `
  :host { all: initial; }

  /* Precision-instrument palette: monochrome, white accent, hairline rules.
     Dark by default; inverted (black accent) under prefers-color-scheme: light. */
  .wrap {
    --bg: #0a0a0b;
    --fg: #fafafa;
    --muted: #a1a1aa;
    --faint: #6e6e76;
    --line: rgba(255,255,255,0.14);
    --line-strong: rgba(255,255,255,0.30);
    --field: #161618;
    --accent: #ffffff;       /* was purple */
    --accent-ink: #0a0a0b;   /* text/icon on the white accent */
    --err: #ff6b6b;
    --shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 24px 64px -22px rgba(0,0,0,0.9);
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    .wrap {
      --bg: #ffffff;
      --fg: #0a0a0b;
      --muted: #52525b;
      --faint: #9a9aa2;
      --line: rgba(0,0,0,0.14);
      --line-strong: rgba(0,0,0,0.32);
      --field: #f5f5f5;
      --accent: #0a0a0b;     /* black accent on light */
      --accent-ink: #ffffff;
      --err: #c4302b;
      --shadow: 0 1px 0 rgba(255,255,255,0.6) inset, 0 24px 64px -22px rgba(0,0,0,0.28);
    }
  }

  .wrap {
    position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(6px);
    z-index: 2147483647; font-family: var(--mono);
    width: min(660px, calc(100vw - 32px));
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 4px;
    box-shadow: var(--shadow); padding: 14px;
    opacity: 0; pointer-events: none; transition: opacity .14s ease, transform .14s cubic-bezier(.2,.7,.2,1);
    box-sizing: border-box;
  }
  .wrap.show { opacity: 1; pointer-events: auto; transform: translateX(-50%) translateY(0); }
  @media (prefers-reduced-motion: reduce) {
    .wrap, .wrap.show { transition: opacity .1s linear; transform: translateX(-50%) translateY(0); }
    .spinner { animation: none; }
  }

  .row { display: flex; align-items: stretch; gap: 10px; }

  /* Wordmark: a hard accent block + tracked monospace MORPH. */
  .logo { display: flex; align-items: center; gap: 9px; user-select: none; white-space: nowrap;
    font-size: 11px; font-weight: 700; letter-spacing: .24em; color: var(--fg); padding: 0 2px; }
  .logo .mark { width: 9px; height: 9px; background: var(--accent); display: inline-block; }

  input.q {
    flex: 1; min-width: 0; background: var(--field);
    border: 1px solid var(--line); border-radius: 2px;
    color: var(--fg); font-family: var(--mono); font-size: 13.5px; letter-spacing: -.01em;
    padding: 11px 12px; outline: none; text-overflow: ellipsis;
    transition: border-color .12s ease;
  }
  input.q:focus { border-color: var(--line-strong); }
  input.q::placeholder { color: var(--faint); }

  button {
    border: 0; border-radius: 2px; padding: 0 16px; font-family: var(--mono);
    font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
    cursor: pointer; white-space: nowrap; transition: opacity .12s ease, color .12s ease, border-color .12s ease;
  }
  button:disabled { opacity: .4; cursor: default; }
  .go { background: var(--accent); color: var(--accent-ink);
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 100px; }
  .go:hover:not(:disabled) { opacity: .82; }
  .ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); padding: 8px 12px; }
  .ghost:hover:not(:disabled) { color: var(--fg); border-color: var(--line-strong); }
  .x { background: transparent; color: var(--faint); padding: 0 8px; font-size: 17px; line-height: 1; }
  .x:hover { color: var(--fg); }

  /* Crisp keyboard focus ring. */
  input.q:focus-visible, button:focus-visible, .chip:focus-visible {
    outline: 1px solid var(--accent); outline-offset: 2px;
  }

  /* Suggestion + recent chips — square, hairline, mono. */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; align-items: center; }
  .chips.hidden { display: none; }
  .chips .lead { font-size: 9.5px; letter-spacing: .2em; text-transform: uppercase;
    color: var(--faint); margin-right: 4px; user-select: none; }
  .chip {
    background: transparent; color: var(--muted); border: 1px solid var(--line);
    border-radius: 2px; padding: 5px 9px; font-family: var(--mono); font-size: 11px; letter-spacing: .01em;
    cursor: pointer; white-space: nowrap; transition: color .12s ease, border-color .12s ease, background .12s ease;
    /* Recent prompts are arbitrary user text — clamp each chip so a long prompt
       can't overflow the bar; full text stays available via the title tooltip. */
    max-width: 200px; overflow: hidden; text-overflow: ellipsis;
  }
  .chip.dismiss { max-width: none; }
  .chip:hover { color: var(--fg); border-color: var(--line-strong); background: var(--field); }
  .chip.dismiss { padding: 5px 7px; color: var(--faint); }

  .status {
    font-size: 11.5px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line);
    min-height: 15px; color: var(--muted); display: none; line-height: 1.55;
    word-break: break-word; overflow-wrap: anywhere; max-height: 8.5em; overflow-y: auto;
  }
  .status.show { display: block; }
  .status.err { color: var(--err); }
  .status.ok { color: var(--fg); }
  .status b { font-weight: 700; color: var(--fg); }

  .actions { display: none; gap: 8px; margin-top: 12px; }
  .actions.show { display: flex; }

  /* Connector suggestion ("You're on Gmail — connect …"). */
  .connector { display: none; align-items: center; gap: 10px; margin-top: 12px;
    padding: 10px 12px; border: 1px solid var(--line); border-radius: 2px; background: var(--field); }
  .connector.show { display: flex; }
  .connector .ctext { flex: 1; font-size: 11px; color: var(--muted); line-height: 1.45; letter-spacing: .01em; }
  .connector .ctext b { color: var(--fg); font-weight: 700; }
  .connector .cbtn { background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 2px;
    padding: 7px 12px; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; cursor: pointer; white-space: nowrap; }
  .connector .cbtn:hover { opacity: .85; }
  .connector .cx { background: transparent; border: 0; color: var(--faint); cursor: pointer;
    font-size: 15px; line-height: 1; padding: 0 4px; }
  .connector .cx:hover { color: var(--fg); }

  /* Element-picker button + targeted-element indicator. */
  .aim { background: transparent; color: var(--muted); border: 1px solid var(--line);
    padding: 0 12px; font-size: 15px; line-height: 1; }
  .aim:hover:not(:disabled) { color: var(--fg); border-color: var(--line-strong); }
  .aim.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .target { display: none; align-items: center; gap: 8px; margin-top: 10px;
    padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 2px; background: var(--field); }
  .target.show { display: flex; }
  .target .ttext { flex: 1; font-size: 11px; color: var(--fg); letter-spacing: .01em; line-height: 1.4;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .target .ttext b { font-weight: 700; }
  .target .tx { background: transparent; border: 0; color: var(--faint); cursor: pointer;
    font-size: 15px; line-height: 1; padding: 0 4px; }
  .target .tx:hover { color: var(--fg); }

  .spinner { display: inline-block; width: 11px; height: 11px; border: 1.5px solid rgba(127,127,140,0.4);
    border-top-color: var(--accent-ink); border-radius: 50%; animation: spin .6s linear infinite; vertical-align: -1px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  `;

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Morph prompt');
    // Static structure only — no untrusted text is interpolated here.
    wrap.innerHTML = `
      <div class="row">
        <div class="logo" aria-hidden="true"><i class="mark"></i>MORPH</div>
        <input class="q" type="text" autocomplete="off" spellcheck="false"
          aria-label="Describe how this page should look"
          placeholder="Reshape this page…" />
        <button class="aim" type="button" aria-label="Pick an element to target" title="Pick an element to change (Esc to cancel)">⌖</button>
        <button class="go" aria-label="Reshape the page">
          <span class="go-spin" hidden><span class="spinner"></span></span><span class="go-label">Morph it</span>
        </button>
        <button class="x" aria-label="Close Morph" title="Close (Esc)">×</button>
      </div>
      <div class="connector" role="note">
        <span class="ctext"></span>
        <button class="cbtn" type="button">Connect</button>
        <button class="cx" type="button" aria-label="Dismiss connector suggestion">×</button>
      </div>
      <div class="target" role="note">
        <span class="ttext"></span>
        <button class="tx" type="button" aria-label="Clear the targeted element">×</button>
      </div>
      <div class="chips examples" aria-label="Example prompts"></div>
      <div class="chips recent" aria-label="Recent prompts" hidden></div>
      <div class="status" role="status" aria-live="polite"></div>
      <div class="actions">
        <button class="ghost undo" aria-label="Undo and forget this site's recipe">Undo &amp; forget</button>
      </div>
    `;
    root.appendChild(wrap);

    els = {
      wrap,
      input: wrap.querySelector('input.q'),
      go: wrap.querySelector('.go'),
      goLabel: wrap.querySelector('.go-label'),
      goSpin: wrap.querySelector('.go-spin'),
      close: wrap.querySelector('.x'),
      examples: wrap.querySelector('.chips.examples'),
      recent: wrap.querySelector('.chips.recent'),
      status: wrap.querySelector('.status'),
      actions: wrap.querySelector('.actions'),
      undo: wrap.querySelector('.undo'),
      connector: wrap.querySelector('.connector'),
      ctext: wrap.querySelector('.connector .ctext'),
      cbtn: wrap.querySelector('.connector .cbtn'),
      cx: wrap.querySelector('.connector .cx'),
      aim: wrap.querySelector('.aim'),
      target: wrap.querySelector('.target'),
      ttext: wrap.querySelector('.target .ttext'),
      tx: wrap.querySelector('.target .tx'),
    };

    renderExamples();

    els.go.addEventListener('click', submit);
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
    });
    els.input.addEventListener('input', updateChipVisibility);

    // Contain ALL keystrokes inside the bar so they never reach the host page's
    // global keyboard shortcuts (e.g. GitHub/Gmail/X single-key hotkeys that
    // would otherwise fire because our shadow-host is not a recognized input).
    // stopPropagation does not block typing (default action still happens).
    ['keydown', 'keyup', 'keypress'].forEach((evt) =>
      wrap.addEventListener(evt, (e) => { e.stopPropagation(); }));
    els.close.addEventListener('click', hide);
    els.undo.addEventListener('click', () => handlers.onUndo && handlers.onUndo());
    els.cbtn.addEventListener('click', () => { if (connectHandler) connectHandler(); });
    els.cx.addEventListener('click', hideConnector);
    els.aim.addEventListener('click', () => { if (handlers.onPick) handlers.onPick(); });
    els.tx.addEventListener('click', () => { const cb = targetClear; clearTarget(); if (cb) cb(); });

    // Focus trap + Esc, scoped to the shadow root while visible.
    wrap.addEventListener('keydown', onWrapKeydown);

    (document.body || document.documentElement).appendChild(host);

    // Drop the legacy global recents, then pull THIS site's recents asynchronously;
    // never throws if chrome.storage is absent.
    removeLegacyRecent();
    loadRecent();
  }

  // --- example / recent chip rendering (text is injected via textContent only) ---

  function makeChip(text, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (cls ? ' ' + cls : '');
    b.textContent = text;                 // NEVER innerHTML — text may be user-authored.
    b.setAttribute('aria-label', 'Use prompt: ' + text);
    return b;
  }

  function fillAndSubmit(text) {
    if (!els) return;
    els.input.value = text;
    els.input.focus();
    submit();                             // routes through the same submit() so onSubmit fires unchanged
  }

  function renderExamples() {
    if (!els) return;
    els.examples.textContent = '';
    if (!currentSuggestions.length) { els.examples.hidden = true; return; }
    els.examples.hidden = false;
    currentSuggestions.forEach((ex) => {
      const chip = makeChip(ex);
      chip.addEventListener('click', () => fillAndSubmit(ex));
      els.examples.appendChild(chip);
    });
    updateChipVisibility();
  }

  // Set the site-special suggestion chips (plain strings; rendered via textContent).
  // An empty list HIDES the row — generic restyle is offered by the one-tap presets,
  // so we never duplicate it here.
  function setSuggestions(list) {
    currentSuggestions = Array.isArray(list)
      ? list.filter((s) => typeof s === 'string' && s.trim()).slice(0, 8)
      : [];
    if (els) renderExamples();
  }

  function renderRecent(list) {
    if (!els) return;
    els.recent.textContent = '';
    const items = Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim()) : [];
    if (!items.length) { els.recent.hidden = true; return; }

    const lead = document.createElement('span');
    lead.className = 'lead';
    lead.textContent = 'Recent';
    els.recent.appendChild(lead);

    items.slice(0, RECENT_CAP).forEach((p) => {
      const chip = makeChip(p);
      chip.title = p;
      chip.addEventListener('click', () => fillAndSubmit(p));
      els.recent.appendChild(chip);
    });

    const clear = makeChip('×', 'dismiss');
    clear.setAttribute('aria-label', 'Clear recent prompts');
    clear.title = 'Clear recent prompts';
    clear.addEventListener('click', clearRecent);
    els.recent.appendChild(clear);

    els.recent.hidden = false;
  }

  // Examples are unobtrusive: hidden once a recipe is active or the input has text.
  function updateChipVisibility() {
    if (!els) return;
    const hasText = !!els.input.value.trim();
    els.examples.classList.toggle('hidden', recipeActive || hasText);
  }

  // --- recent-prompts memory (chrome.storage.local, guarded for jsdom/plain DOM) ---

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  // Pure: dedupe (case-insensitive), most-recent-first, capped. Exported for tests below.
  function updateRecentList(list, prompt, cap) {
    const max = cap || RECENT_CAP;
    const next = Array.isArray(list) ? list.slice() : [];
    const p = String(prompt == null ? '' : prompt).trim();
    if (!p) return next.slice(0, max);
    const out = [p];
    for (const item of next) {
      if (typeof item !== 'string') continue;
      const t = item.trim();
      if (!t) continue;
      if (t.toLowerCase() === p.toLowerCase()) continue;
      out.push(t);
      if (out.length >= max) break;
    }
    return out.slice(0, max);
  }

  // The current site's bucket key. Recents are scoped to the page origin.
  function originKey() {
    try { return location.origin || '(unknown)'; } catch (_) { return '(unknown)'; }
  }

  // Pure: write `prompt` into the per-origin recent map and return a NEW map. Each origin
  // keeps its own deduped/capped list; the number of origins is bounded (oldest-written
  // dropped first). Exported for tests below.
  function updateRecentMap(map, origin, prompt, cap, maxOrigins) {
    const m = map && typeof map === 'object' && !Array.isArray(map) ? Object.assign({}, map) : {};
    const key = origin || '(unknown)';
    const list = updateRecentList(Array.isArray(m[key]) ? m[key] : [], prompt, cap);
    delete m[key];               // re-insert last so this origin is "most recently written"
    if (list.length) m[key] = list;
    const capN = maxOrigins || MAX_ORIGINS;
    const keys = Object.keys(m);  // insertion order
    if (keys.length > capN) for (const k of keys.slice(0, keys.length - capN)) delete m[k];
    return m;
  }

  function loadRecent() {
    if (!hasStorage()) return;
    try {
      chrome.storage.local.get(RECENT_KEY, (d) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        const map = (d && d[RECENT_KEY]) || {};
        renderRecent(map[originKey()] || []);
      });
    } catch (_) { /* ignore */ }
  }

  function pushRecent(prompt) {
    if (!hasStorage()) return;
    try {
      chrome.storage.local.get(RECENT_KEY, (d) => {
        const origin = originKey();
        const map = updateRecentMap((d && d[RECENT_KEY]) || {}, origin, prompt, RECENT_CAP, MAX_ORIGINS);
        chrome.storage.local.set({ [RECENT_KEY]: map }, () => {
          if (chrome.runtime && chrome.runtime.lastError) return;
          renderRecent(map[origin] || []);
        });
      });
    } catch (_) { /* ignore */ }
  }

  function clearRecent() {
    if (hasStorage()) {
      try {
        chrome.storage.local.get(RECENT_KEY, (d) => {
          const map = (d && d[RECENT_KEY]) || {};
          delete map[originKey()];          // clear THIS site only
          chrome.storage.local.set({ [RECENT_KEY]: map });
        });
      } catch (_) {}
    }
    renderRecent([]);
  }

  // One-time cleanup of the pre-1.0.5 global recents key so old cross-site prompts vanish.
  function removeLegacyRecent() {
    if (!hasStorage()) return;
    try { chrome.storage.local.remove(LEGACY_RECENT_KEY); } catch (_) {}
  }

  // --- submit ---

  function submit() {
    const q = els.input.value.trim();
    if (!q || !handlers.onSubmit) return;
    // Optimistically remember the prompt; content.js drives the actual success/error UI.
    pushRecent(q);
    handlers.onSubmit(q);
  }

  // --- status (TRUSTED markup) ---
  //
  // INVARIANT: setStatus receives TRUSTED HTML from content.js — it passes spinner/<b>
  // markup plus user text that content.js has ALREADY escaped via its own escapeHtml().
  // We MUST render it with innerHTML and MUST NOT escape here; escaping would double-encode
  // the user text and break the spinner/bold markup. This is part of the public contract.
  function setStatus(text, kind) {
    els.status.className = 'status show' + (kind ? ' ' + kind : '');
    els.status.innerHTML = text;
    els.status.scrollTop = 0;
  }
  function clearStatus() { els.status.className = 'status'; els.status.innerHTML = ''; }

  function setBusy(busy) {
    els.go.disabled = busy;
    els.input.disabled = busy;
    if (els.goSpin) els.goSpin.hidden = !busy;
    if (els.goLabel) els.goLabel.textContent = busy ? 'Reshaping…' : 'Morph it';
    // Disable chips while busy so a second submit can't race.
    setChipsDisabled(busy);
    els.wrap.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (busy) setStatus('<span class="spinner"></span>Reshaping the page…');
  }

  function setChipsDisabled(disabled) {
    if (!els) return;
    const chips = els.wrap.querySelectorAll('.chip');
    chips.forEach((c) => { c.disabled = !!disabled; });
  }

  function showActions(show) {
    els.actions.className = 'actions' + (show ? ' show' : '');
    // A live recipe means example chips are no longer the right first thing to show.
    recipeActive = !!show;
    updateChipVisibility();
  }

  // --- focus trap ---

  function focusable() {
    if (!root) return [];
    const sel = 'input:not([disabled]), button:not([disabled]):not([hidden])';
    return Array.prototype.filter.call(root.querySelectorAll(sel), (el) => {
      // Skip elements inside a hidden chips row.
      if (el.classList && el.classList.contains('chip')) {
        const rowHidden = el.closest('.chips') && el.closest('.chips').hidden;
        const rowOff = el.closest('.chips') && el.closest('.chips').classList.contains('hidden');
        if (rowHidden || rowOff) return false;
      }
      return el.offsetParent !== null || el === els.input;
    });
  }

  function onWrapKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
    if (e.key !== 'Tab' || !visible) return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = root.activeElement;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !root.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }

  // --- show / hide ---

  function show() {
    if (!host) build();
    visible = true;
    lastFocused = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement : null;
    updateChipVisibility();
    requestAnimationFrame(() => els.wrap.classList.add('show'));
    setTimeout(() => els.input && els.input.focus(), 60);
  }
  function hide() {
    if (!host) return;
    visible = false;
    els.wrap.classList.remove('show');
    // Let content.js tear down transient state (cancel pick mode, drop the target).
    if (handlers.onHide) { try { handlers.onHide(); } catch (_) {} }
    // Restore focus to whatever the page had before we opened — never trap when idle.
    const target = lastFocused;
    lastFocused = null;
    if (target && typeof target.focus === 'function' && document.contains(target)) {
      try { target.focus(); } catch (_) {}
    }
  }
  function toggle() { visible ? hide() : show(); }

  function focusInput() { if (els && els.input) els.input.focus(); }

  // Connector suggestion ("You're on Gmail — connect …"). info: {name, blurb, onConnect}.
  function setConnector(info) {
    if (!els || !info) return;
    connectHandler = typeof info.onConnect === 'function' ? info.onConnect : null;
    els.ctext.textContent = '';
    const b = document.createElement('b');
    b.textContent = info.name || 'this app';
    els.ctext.appendChild(b);
    els.ctext.appendChild(document.createTextNode(' — connect to ' + (info.blurb || 'pull real data') + '.'));
    els.cbtn.textContent = info.cta || 'Connect';
    els.connector.classList.add('show');
  }
  function hideConnector() { if (els) els.connector.classList.remove('show'); }
  function setConnectorBusy(text) { if (els) els.ctext.textContent = text || 'Connecting…'; }

  // Targeted-element indicator. info: { label, onClear }. Text is set via
  // textContent (label may be page-authored), never innerHTML.
  function setTarget(info) {
    if (!els || !info) return;
    targetClear = typeof info.onClear === 'function' ? info.onClear : null;
    els.ttext.textContent = '';
    els.ttext.appendChild(document.createTextNode('Targeting '));
    const b = document.createElement('b');
    b.textContent = info.label || 'element';
    els.ttext.appendChild(b);
    els.target.classList.add('show');
    if (els.aim) els.aim.classList.add('on');
  }
  function clearTarget() {
    if (!els) return;
    els.target.classList.remove('show');
    if (els.aim) els.aim.classList.remove('on');
    targetClear = null;
  }
  function aimActive(on) { if (els && els.aim) els.aim.classList.toggle('on', !!on); }

  window.Morph.bar = {
    mount(h) { handlers = h || {}; if (!host) build(); },
    show, hide, toggle,
    setStatus, clearStatus, setBusy, showActions,
    isVisible: () => visible,
    clearInput: () => { if (els) { els.input.value = ''; updateChipVisibility(); } },
    // Non-breaking additions:
    focusInput,
    setRecent: (list) => renderRecent(list),
    setSuggestions,
    setConnector, hideConnector, setConnectorBusy,
    setTarget, clearTarget, aimActive,
  };

  // Expose pure helper for the optional test harness without coupling to chrome/DOM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { updateRecentList, updateRecentMap };
  }
})();
