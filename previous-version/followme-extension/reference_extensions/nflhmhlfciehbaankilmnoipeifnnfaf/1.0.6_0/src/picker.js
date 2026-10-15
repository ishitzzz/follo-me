/*
 * Element picker — lets the user click a specific element on the page so the next
 * reshape is scoped to it (and its descendants) instead of the model guessing
 * selectors across the whole page.
 *
 *   start(onPick, onCancel) : enter pick mode (hover highlights, click selects, Esc cancels)
 *   stop()                  : leave pick mode
 *   selectorFor(el, doc)    : PURE — a stable-ish unique CSS selector for el
 *   describe(el)            : PURE — a short human label for el
 *
 * Attaches to window.Morph.picker. Pure helpers are CJS-exported for tests.
 */
(function () {
  'use strict';
  window.Morph = window.Morph || {};

  // Prefer the spec-correct native CSS.escape (all modern browsers have it). Fall
  // back (e.g. jsdom / very old engines) to a regex that backslash-escapes any
  // non-identifier char AND escapes a leading digit per the CSS spec — otherwise
  // an id like "2col" yields the INVALID selector "#2col", which throws at
  // querySelectorAll and forces a weaker, possibly non-unique path.
  function cssEscape(s) {
    s = String(s);
    if (typeof window !== 'undefined' && window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(s);
    }
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c).replace(/^([0-9])/, (m, d) => '\\3' + d + ' ');
  }

  // A reasonably-unique selector: prefer a unique #id (anchoring the path there if
  // an ancestor has one), else a short `>`-path with :nth-of-type disambiguation.
  function selectorFor(el, doc) {
    doc = doc || (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!el || el.nodeType !== 1 || !doc) return '';
    if (el.id) {
      const sel = '#' + cssEscape(el.id);
      try { if (doc.querySelectorAll(sel).length === 1) return sel; } catch (_) { /* keep going */ }
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement && depth < 6) {
      if (node.id) {
        const idSel = '#' + cssEscape(node.id);
        let unique = false;
        try { unique = doc.querySelectorAll(idSel).length === 1; } catch (_) { unique = false; }
        if (unique) { parts.unshift(idSel); return parts.join(' > '); }
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentNode;
      if (parent && parent.children) {
        const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentNode;
      depth++;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return 'element';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + el.classList[0];
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (text) s += ' “' + text + '”';
    return s;
  }

  // --- interactive pick mode (needs a live DOM) -----------------------------
  let active = false, overlay = null, current = null, pickCb = null, cancelCb = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-morph-pick-overlay', '1');
    const s = overlay.style;
    s.position = 'fixed'; s.zIndex = '2147483646'; s.pointerEvents = 'none';
    s.border = '2px solid #ffffff'; s.boxShadow = '0 0 0 1px #000, 0 0 0 4px rgba(255,255,255,0.25)';
    s.background = 'rgba(255,255,255,0.06)'; s.borderRadius = '2px'; s.display = 'none';
    s.transition = 'left .04s linear, top .04s linear, width .04s linear, height .04s linear';
    return overlay;
  }

  // Never let the picker target Morph's own UI (the bar host or this overlay).
  function isOurs(el) {
    try { return !!(el && el.closest && el.closest('#morph-host-root, [data-morph-pick-overlay]')); }
    catch (_) { return false; }
  }

  function moveOverlay(el) {
    const r = el.getBoundingClientRect();
    const s = overlay.style;
    s.display = 'block';
    s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
  }

  function onMove(e) {
    const el = e.target;
    if (!el || isOurs(el)) { overlay.style.display = 'none'; current = null; return; }
    current = el;
    try { moveOverlay(el); } catch (_) { /* never break the page */ }
  }
  function onClick(e) {
    if (isOurs(e.target)) return;          // let our own UI receive clicks
    e.preventDefault(); e.stopPropagation();
    finish(current || e.target);
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }

  function teardown() {
    active = false; current = null;
    try {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (document.documentElement) document.documentElement.style.cursor = '';
      if (overlay) overlay.style.display = 'none';
    } catch (_) { /* noop */ }
  }
  function finish(el) { const cb = pickCb; teardown(); if (cb) { try { cb(el); } catch (_) {} } }
  function cancel() { const cb = cancelCb; teardown(); if (cb) { try { cb(); } catch (_) {} } }

  function start(onPick, onCancel) {
    if (active) return;
    active = true; pickCb = onPick; cancelCb = onCancel;
    try {
      ensureOverlay();
      (document.body || document.documentElement).appendChild(overlay);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      if (document.documentElement) document.documentElement.style.cursor = 'crosshair';
    } catch (_) { teardown(); }
  }
  function stop() { teardown(); }
  function isActive() { return active; }

  window.Morph.picker = { start, stop, isActive, selectorFor, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = { selectorFor, describe };
})();
