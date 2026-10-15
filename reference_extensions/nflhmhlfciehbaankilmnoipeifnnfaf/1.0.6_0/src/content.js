/*
 * Content orchestrator. Loaded last (after dsl/context/recipes/promptbar in the manifest).
 *  - On load: remove any document_start (early.js) styles, then auto-apply the saved
 *    recipe for this URL (per-path scoped) as the single post-idle owner.
 *  - SPA-aware: re-applies idempotently on client-side route changes (pushState/
 *    replaceState/popstate/hashchange) with a MutationObserver fallback, all debounced
 *    and loop-guarded so it never degrades page performance.
 *  - Wires the prompt bar: submit -> backend -> validate -> apply -> offer to keep.
 *  - Every apply path is wrapped so no uncaught error ever reaches the host page.
 */
(function () {
  'use strict';
  if (window.__morphLoaded) return; // guard against double-injection
  window.__morphLoaded = true;
  window.Morph = window.Morph || {};
  const M = window.Morph;
  const DSL = window.MorphDSL;

  let currentHandle = null;   // handle of the transform currently applied (for undo)
  let lastResult = null;      // { prompt, transform } of the most recent successful apply
  let lastUrlKey = null;      // URL key of the last (attempted) apply, for SPA gating
  let reapplyInFlight = false;
  let wantApplied = false;    // true when an enabled recipe is meant to be on this page
  let activeTransform = null; // transform that should stay applied (drives reconcile)
  let activeGroupId = 'morph';
  let activeData = {};
  let activeTarget = null;    // { selector, anchor, label } when the user picked an element
  let targetEl = null;        // live ref to the targeted element (for outline + outerHTML)
  const origin = location.origin;

  // A tiny sentinel node placed in <body> on every successful apply. If the page
  // (e.g. a Turbo/SPA framework) re-renders and wipes the body on the SAME url,
  // the sentinel disappears too — that's our signal to re-apply. It lives in the
  // body (not head) precisely so a body-only re-render is detectable.
  const SENTINEL_ATTR = 'data-morph-sentinel';
  function ensureSentinel() {
    try {
      if (!document.body) return;
      if (document.body.querySelector('[' + SENTINEL_ATTR + ']')) return;
      const s = document.createElement('style');
      s.setAttribute(SENTINEL_ATTR, '1');
      document.body.appendChild(s);
    } catch (_) { /* never break the page */ }
  }
  function morphPresent() {
    try {
      return !!(document.body && document.body.querySelector(
        '[' + SENTINEL_ATTR + '],[data-morph-added]'
      ));
    } catch (_) { return true; }
  }
  function removeSentinel() {
    try {
      document.querySelectorAll('[' + SENTINEL_ATTR + ']').forEach((n) => { try { n.remove(); } catch (_) {} });
    } catch (_) { /* never break the page */ }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Fire-and-forget capture signal (kept on save / undone on undo). Never blocks
  // the UI. Sends only kind + url + prompt; the backend buckets the intent and
  // hashes the site — it never stores the raw prompt/DOM. (See /api/event.)
  function emitEvent(kind, prompt) {
    try {
      chrome.runtime.sendMessage({ type: 'morph:event', kind, url: location.href, prompt: prompt || '' });
    } catch (_) { /* telemetry is best-effort */ }
  }

  // --- pure URL helpers (also exposed on window.Morph.__nav for ESM tests) ---
  function keyOf(loc) {
    const l = loc || location;
    return (l.origin || '') + (l.pathname || '') + (l.search || '') + (l.hash || '');
  }
  function urlChanged(prev, next) {
    return keyOf(prev) !== keyOf(next);
  }

  // --- remove document_start (early.js) CSS so the full apply owns injectCSS ---
  function clearEarlyStyles() {
    try {
      const tracked = Array.isArray(window.__morphEarlyStyles) ? window.__morphEarlyStyles : [];
      for (const node of tracked) { try { node && node.remove(); } catch (_) {} }
      window.__morphEarlyStyles = [];
      // Belt-and-suspenders: remove any stragglers by attribute.
      const stray = document.querySelectorAll('style[data-morph-early="1"]');
      stray.forEach((n) => { try { n.remove(); } catch (_) {} });
    } catch (_) { /* never break the page */ }
  }

  // --- apply a (raw) transform: validate+sanitize here, where the DOM exists ---
  function applyRaw(rawTransform, opts) {
    const { ok, transform, skipped } = DSL.validateTransform(rawTransform);
    if (!ok) return { ok: false, skipped, reason: 'no applicable operations' };
    if (currentHandle) { DSL.undoTransform(currentHandle); currentHandle = null; }
    const handle = DSL.applyTransform(transform, document, opts);
    currentHandle = handle;
    // Track what should stay applied so the reconcile loop can re-assert it on
    // freshly-rendered nodes, and give it a fresh hard-cap budget.
    activeTransform = transform;
    activeGroupId = (opts && opts.groupId) || 'morph';
    activeData = (opts && opts.data) || {};
    if (reconcileCtrl) { reconcileCtrl.reset(); if (handle.applied > 0) reconcileCtrl.markApplied(); }
    return { ok: true, transform, handle, skipped };
  }

  // --- STACK a new reshape on top of the current one (live submit path) --------
  // Unlike applyRaw (which replaces), this does NOT undo the live handle: it applies
  // the new ops on top, folds their undos into currentHandle so a single Undo still
  // reverses everything, and unions activeTransform so reconcile re-asserts ALL ops.
  // This is why "remove images" then "remove text" now leaves both removed.
  function applyAdditive(rawTransform, opts) {
    const { ok, transform, skipped } = DSL.validateTransform(rawTransform);
    if (!ok) return { ok: false, skipped, reason: 'no applicable operations' };
    const handle = DSL.applyTransform(transform, document, opts);
    if (currentHandle && Array.isArray(currentHandle.undos) && Array.isArray(handle.undos)) {
      for (const u of handle.undos) currentHandle.undos.push(u);
      currentHandle.applied = (currentHandle.applied || 0) + handle.applied;
      currentHandle.failed = (currentHandle.failed || 0) + handle.failed;
    } else {
      currentHandle = handle;
    }
    activeTransform = (activeTransform && Array.isArray(activeTransform.ops) && DSL.mergeTransforms)
      ? DSL.mergeTransforms(activeTransform, transform)
      : transform;
    activeGroupId = (opts && opts.groupId) || 'morph';
    activeData = Object.assign({}, activeData, (opts && opts.data) || {});
    if (reconcileCtrl) { reconcileCtrl.reset(); if (currentHandle && currentHandle.applied > 0) reconcileCtrl.markApplied(); }
    return { ok: true, transform, handle, skipped };
  }

  // --- auto-apply saved recipe for the current URL ---
  async function autoApply() {
    try {
      lastUrlKey = keyOf(location);
      activeTransform = null; // cleared unless a recipe applies below (drives reconcile)
      const recipe = await M.recipes.get(origin);
      // NOTE: we do NOT skip `stale` recipes — staleness is an informational flag,
      // not a kill switch. The site may simply not be fully rendered yet; keep
      // trying so a recipe self-heals instead of vanishing forever.
      if (!recipe || !recipe.enabled) { wantApplied = false; return; }
      // Per-path scoping: origin-only recipes apply everywhere; scoped ones only match.
      if (M.recipes.recipeAppliesTo && !M.recipes.recipeAppliesTo(recipe, location.href)) {
        wantApplied = false; return;
      }
      // A saved chart recipe needs live data again; fetch it only when the recipe
      // actually uses renderData (no needless network on plain restyle recipes).
      let data = {};
      try {
        const ops = recipe.transform && recipe.transform.ops;
        if (Array.isArray(ops) && ops.some((o) => o && o.op === 'renderData')) {
          data = (await gatherSiteData()).data;
        }
      } catch (_) { /* best-effort */ }
      let res;
      try {
        res = applyRaw(recipe.transform, { groupId: 'morph-recipe', data });
      } catch (_) {
        return; // applyRaw itself blew up — never break the page
      }
      if (!res || !res.ok) return;
      const applied = res.handle.applied;
      const total = applied + res.handle.failed;
      // Keep whatever applied; NEVER undo a partial success (a single missing
      // addElement target must not nuke the whole morph). Only flag stale (for
      // the popup) when literally nothing applied; clear it once it recovers.
      if (applied > 0) {
        wantApplied = true;
        ensureSentinel();
        if (recipe.stale) { await M.recipes.markStale(origin, false); }
      } else {
        wantApplied = false;
        if (total > 0 && !recipe.stale) { await M.recipes.markStale(origin, true); }
      }
    } catch (_) { /* never break the page */ }
  }

  // --- debounced SPA re-apply -----------------------------------------------
  function debounce(fn, ms) {
    let t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; try { fn(); } catch (_) {} }, ms);
    };
  }

  // --- bounded reconcile: re-assert the active transform onto freshly-rendered
  // nodes (SPA re-renders) without spinning the CPU. The controller caps after
  // `stableStop` consecutive ticks that re-asserted nothing OR `maxAttempts`
  // total; a URL change or a fresh apply resets the budget. Pure + unit-tested.
  function createReconcileController(opts) {
    const maxAttempts = (opts && opts.maxAttempts) || 40;
    const stableStop = (opts && opts.stableStop) || 3;
    const run = (opts && opts.run) || (() => 0);
    let attempts = 0, stable = 0, capped = false, everApplied = false;
    return {
      tick() {
        if (capped) return { ran: false, capped: true, attempts, stable };
        attempts++;
        let reapplied = 0;
        try { reapplied = run() | 0; } catch (_) { reapplied = 0; }
        if (reapplied > 0) { stable = 0; everApplied = true; } else stable++;
        // Do NOT permanently cap on "stable" (zero-work) ticks until the reshape
        // has matched at least once. On client-rendered/SPA pages the targets may
        // not have rendered at document_idle; capping early (the old behavior) is
        // exactly why reshapes reverted on refresh. maxAttempts still bounds work.
        if ((everApplied && stable >= stableStop) || attempts >= maxAttempts) capped = true;
        return { ran: true, reapplied, capped, attempts, stable };
      },
      reset() { attempts = 0; stable = 0; capped = false; everApplied = false; },
      // Seed everApplied from the initial apply so a page whose targets ARE present
      // at load re-caps normally once settled (no needless ticking on static pages).
      markApplied() { everApplied = true; },
      isCapped() { return capped; },
      state() { return { attempts, stable, capped, everApplied }; },
    };
  }

  // Re-assert the active transform onto new nodes; fold the new undos into the
  // live handle so undo still reverses everything. Returns the re-assert count.
  function runReconcile() {
    if (!activeTransform || !DSL.reconcile) return 0;
    let r;
    try { r = DSL.reconcile(activeTransform, document, { groupId: activeGroupId, data: activeData }); }
    catch (_) { return 0; }
    if (r && r.reapplied > 0) {
      if (currentHandle && Array.isArray(currentHandle.undos) && Array.isArray(r.undos)) {
        for (const u of r.undos) currentHandle.undos.push(u);
      }
      ensureSentinel();
    }
    return (r && r.reapplied) || 0;
  }

  const reconcileCtrl = createReconcileController({ run: runReconcile, maxAttempts: 40, stableStop: 3 });

  async function reapply(force) {
    if (reapplyInFlight) return; // loop / recursion guard
    reapplyInFlight = true;
    try {
      // Bail only when nothing meaningful changed: same URL AND our morph is still
      // on the page. `force` (a same-URL DOM wipe) and URL changes both proceed.
      // (lastUrlKey === null on the very first run, so that always proceeds.)
      if (!force && lastUrlKey !== null && lastUrlKey === keyOf(location) && morphPresent()) return;
      if (currentHandle) { try { DSL.undoTransform(currentHandle); } catch (_) {} currentHandle = null; }
      await autoApply(); // autoApply updates lastUrlKey
    } catch (_) { /* never break the page */ }
    finally {
      reapplyInFlight = false;
    }
  }

  const reapplyDebounced = debounce(() => { reapply(false); }, 200);

  // Gather connector data for the current site (best-effort). Returns
  //   { text:string, data:{ [dataKey]: {fields,records} }, appId:string }
  // publicData apps (GitHub) are fetched client-side here: the text enriches the
  // model context and the structured records feed the trusted renderData chart op.
  // Composio apps return only an appId so the backend pulls + enriches server-side.
  async function gatherSiteData() {
    const out = { text: '', data: {}, appId: '' };
    try {
      const C = M.connectors;
      if (!C || !C.detect) return out;
      const app = C.detect(location.hostname);
      if (!app) return out;
      if (app.publicData && C.fetchSiteDataset) {
        const r = await C.fetchSiteDataset(app, location);
        if (r) { if (r.text) out.text = r.text; if (r.key && r.dataset) out.data[r.key] = r.dataset; }
      } else {
        // Authoritative check (Composio via backend) — not the optimistic local flag.
        const connected = await isAppConnected(app.id);
        if (connected) out.appId = app.id;
      }
    } catch (_) { /* connector data is best-effort */ }
    return out;
  }

  // --- element targeting: pick an element, scope the next reshape(s) to it ---
  function ensureTargetStyle() {
    if (document.getElementById('morph-target-style')) return;
    try {
      const s = document.createElement('style');
      s.id = 'morph-target-style';
      s.textContent = '[data-morph-targeted]{outline:2px dashed #2f81f7 !important;outline-offset:2px !important;}';
      (document.head || document.documentElement).appendChild(s);
    } catch (_) { /* never break the page */ }
  }
  function clearTargetOutline() {
    try { document.querySelectorAll('[data-morph-targeted]').forEach((e) => e.removeAttribute('data-morph-targeted')); } catch (_) {}
    targetEl = null;
  }
  function outlineTarget(el) {
    clearTargetOutline();
    try { ensureTargetStyle(); el.setAttribute('data-morph-targeted', '1'); targetEl = el; } catch (_) {}
  }
  function targetHtml() {
    try {
      const el = targetEl || (activeTarget && document.querySelector(activeTarget.selector));
      return el ? String(el.outerHTML).slice(0, 4000) : '';
    } catch (_) { return ''; }
  }
  function clearTarget() {
    activeTarget = null;
    clearTargetOutline();
    try { M.bar.clearTarget(); } catch (_) {}
  }
  // Closing the bar ends targeting: cancel any in-progress pick and drop the lock.
  function onHide() {
    try { if (M.picker && M.picker.stop) M.picker.stop(); } catch (_) {}
    clearTarget();
  }
  function onPick() {
    if (!M.picker || !M.picker.start) return;
    M.bar.setStatus('Click any element on the page to target it — Esc to cancel.', '');
    M.picker.start((el) => {
      try {
        const selector = M.picker.selectorFor(el, document);
        if (!selector) { M.bar.setStatus('Couldn’t target that element — try another.', 'err'); return; }
        activeTarget = { selector, anchor: (DSL.captureAnchor ? DSL.captureAnchor(el) : null), label: M.picker.describe(el) };
        outlineTarget(el);
        M.bar.setTarget({ label: activeTarget.label, onClear: clearTarget });
        M.bar.setStatus('Targeting <b>' + escapeHtml(activeTarget.label) + '</b>. Now type how to change it.', 'ok');
        if (M.bar.focusInput) M.bar.focusInput();
      } catch (_) { /* never break the page */ }
    }, () => {
      try { M.bar.aimActive(false); } catch (_) {}
      M.bar.setStatus('Pick cancelled.', '');
    });
  }

  // --- handlers for the bar ---
  async function onSubmit(prompt) {
    M.bar.setBusy(true);
    M.bar.showActions(false);
    let context = '';
    try { context = M.extractContext(); } catch (_) {}
    const site = await gatherSiteData();
    if (site.text) context += '\n\n' + site.text;
    const appId = site.appId;
    const target = activeTarget ? { selector: activeTarget.selector, html: targetHtml() } : undefined;
    const hadTarget = !!target;

    chrome.runtime.sendMessage(
      { type: 'morph:transform', payload: { prompt, context, url: location.href, app: appId, target } },
      (resp) => {
        M.bar.setBusy(false);
        if (chrome.runtime.lastError) {
          return M.bar.setStatus('Could not reach Morph. Is the extension/back end running?', 'err');
        }
        if (resp && resp.authRequired) {
          return M.bar.setStatus('Couldn’t verify your session. Reload the page and try again.', 'err');
        }
        if (!resp || !resp.ok) {
          return M.bar.setStatus('Error: ' + escapeHtml((resp && resp.error) || 'unknown'), 'err');
        }
        let res;
        try {
          // STACK on top of any reshape already applied this session (additive),
          // so successive prompts accumulate instead of replacing each other.
          res = applyAdditive(resp.transform, { groupId: 'morph-live', data: site.data });
        } catch (_) {
          return M.bar.setStatus('Something went wrong applying that change.', 'err');
        }
        if (!res || !res.ok) {
          return M.bar.setStatus('Couldn’t make that change here — try rephrasing (e.g. “dark mode”, “hide the sidebar”, “bigger text”).', '');
        }
        lastResult = { prompt, transform: res.transform };
        lastUrlKey = keyOf(location);
        wantApplied = currentHandle && currentHandle.applied > 0;
        ensureSentinel();
        const expl = resp.transform.explanation || 'Done.';
        // Auto-save so the change persists. Capture self-healing anchors now (the
        // targeted elements are live), then UNION onto the site's existing recipe so
        // earlier reshapes persist too. appendTransform does the merge ATOMICALLY in
        // a serialized write queue — rapid reshapes used to race here (read-modify-
        // write) and only the last op survived, so the page reverted on refresh.
        const newAnchored = DSL.withAnchors ? DSL.withAnchors(res.transform, document) : res.transform;
        M.recipes.appendTransform(origin, newAnchored, { prompt }).catch(() => {});
        emitEvent('kept', prompt); // the user accepted this reshape (capture signal)
        let note = '';
        if (res.handle.failed) note += ` (${res.handle.failed} op(s) skipped)`;
        M.bar.setStatus('✓ ' + escapeHtml(expl) + ' <b>Saved for this site</b> — reapplies on every visit.' + note, 'ok');
        M.bar.showActions(true);
        if (hadTarget) clearTarget(); // the target did its job — unlock it after a successful edit
      }
    );
  }

  async function onUndo() {
    emitEvent('undone', lastResult && lastResult.prompt);
    if (currentHandle) { DSL.undoTransform(currentHandle); currentHandle = null; }
    // Tear down everything that could re-apply what we just reverted. Without this,
    // undo's own DOM changes wake the MutationObserver: its reconcile branch
    // (activeTransform) and its "morph went missing" branch (wantApplied) both
    // re-apply the reshape — so it visibly came back until a manual refresh.
    activeTransform = null;
    wantApplied = false;
    if (reconcileCtrl) reconcileCtrl.reset();
    removeSentinel();
    await M.recipes.remove(origin); // undo also forgets any saved recipe for this site
    lastResult = null;
    M.bar.setStatus('Reverted this page to its original look.', '');
    M.bar.showActions(false);
  }

  async function onShow() {
    // Site-aware suggestion chips (only capabilities deliverable today).
    try {
      const C = M.connectors;
      if (C && C.suggestionsFor && M.bar.setSuggestions) {
        M.bar.setSuggestions(C.suggestionsFor(location.hostname, location.pathname));
      }
    } catch (_) { /* suggestions are best-effort */ }
    const recipe = await M.recipes.get(origin);
    if (recipe) {
      const tag = recipe.stale ? ' (stale — site changed)' : '';
      M.bar.setStatus('Active recipe: “' + escapeHtml(recipe.prompt) + '”' + tag +
        '. Type another instruction to add to it.', '');
    }
    // Connector suggestion: on a known app you haven't connected yet, offer to connect.
    try {
      const C = M.connectors;
      if (C && M.bar.setConnector) {
        const app = C.detect(location.hostname);
        if (app) {
          const connected = app.publicData ? await C.isConnected(app.id) : await isAppConnected(app.id);
          if (!connected) M.bar.setConnector({ name: app.name, blurb: app.blurb, onConnect: () => connectApp(app) });
          else M.bar.hideConnector();
        }
      }
    } catch (_) { /* connector UI is best-effort */ }
  }

  // Authoritative connection check via the backend (Composio), syncing the local flag.
  function isAppConnected(appId) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'morph:connectstatus', app: appId }, (r) => {
          const connected = !!(r && r.connected);
          try { M.connectors.setConnected(appId, connected); } catch (_) {}
          res(connected);
        });
      } catch (_) { res(false); }
    });
  }

  function connectApp(app) {
    M.bar.setConnectorBusy('Connecting ' + app.name + '…');
    chrome.runtime.sendMessage(
      { type: 'morph:connect', app: { id: app.id, name: app.name, publicData: !!app.publicData } },
      async (r) => {
        if (r && r.ok && r.pending) {
          // Do NOT mark connected yet — wait for Composio to confirm. The bar re-checks
          // the real status on next open, so the user authorizes then comes back.
          M.bar.hideConnector();
          M.bar.setStatus('Authorize <b>' + escapeHtml(app.name) + '</b> in the new tab, then reopen Morph (Alt+M) — your data lights up once it’s connected.', 'ok');
        } else if (r && r.ok) {
          try { await M.connectors.setConnected(app.id, true); } catch (_) {}
          M.bar.hideConnector();
          M.bar.setStatus('✓ Connected <b>' + escapeHtml(app.name) + '</b>. Morph can now use its data.', 'ok');
        } else if (r && (r.error === 'composio_not_configured' || r.error === 'connectors not configured')) {
          M.bar.hideConnector();
          M.bar.setStatus('Connectors aren’t set up on the server yet.', '');
        } else if (r && r.error === 'app_not_configured') {
          M.bar.hideConnector();
          M.bar.setStatus(escapeHtml(app.name) + ' isn’t enabled on the connector service yet.', '');
        } else {
          M.bar.setStatus('Could not connect ' + escapeHtml(app.name) + '. Try again.', 'err');
        }
      }
    );
  }

  // --- wire up ---
  M.bar.mount({ onSubmit, onUndo, onPick, onHide });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'morph:ping') { sendResponse({ pong: true }); return; }
    if (msg && msg.type === 'morph:toggle') {
      M.bar.toggle();
      if (M.bar.isVisible()) onShow();
    }
  });

  // --- SPA navigation detection ---------------------------------------------
  function installSpaHooks() {
    try {
      const fire = () => {
        try { window.dispatchEvent(new Event('morph:locationchange')); } catch (_) {}
      };
      const wrap = (name) => {
        try {
          const orig = history[name];
          if (typeof orig !== 'function' || orig.__morphWrapped) return;
          const wrapped = function () {
            const r = orig.apply(this, arguments);
            try { fire(); } catch (_) {}
            return r;
          };
          wrapped.__morphWrapped = true;
          history[name] = wrapped;
        } catch (_) { /* page may freeze history; ignore */ }
      };
      wrap('pushState');
      wrap('replaceState');
      window.addEventListener('popstate', reapplyDebounced);
      window.addEventListener('hashchange', reapplyDebounced);
      window.addEventListener('morph:locationchange', reapplyDebounced);
    } catch (_) { /* never break the page */ }
  }

  // MutationObserver fallback: only acts when the URL key actually changed.
  // The cheap string compare short-circuits before any work to protect perf.
  function installMutationFallback() {
    try {
      if (typeof MutationObserver === 'undefined') return;
      const onMutate = debounce(() => {
        try {
          if (keyOf(location) !== lastUrlKey) { reconcileCtrl.reset(); reapply(false); return; }
          // Same URL but our morph was fully wiped (Turbo/SPA body re-render)
          // -> force a full re-apply so edits survive in-place re-renders.
          if (wantApplied && !morphPresent()) { reconcileCtrl.reset(); reapply(true); return; }
          // In-place partial re-render: re-assert ops onto freshly-rendered nodes,
          // bounded by the hard cap so a constantly-mutating page can't spin the CPU.
          if (activeTransform && !reconcileCtrl.isCapped()) reconcileCtrl.tick();
        } catch (_) {}
      }, 300);
      const addsNodes = (records) => {
        try { for (const r of records) if (r.addedNodes && r.addedNodes.length) return true; } catch (_) {}
        return false;
      };
      const obs = new MutationObserver((records) => {
        // Schedule a (debounced) pass when: the URL changed, our morph went missing,
        // or an active transform still has reconcile budget (to catch partial
        // re-renders). Once settled/capped, do nothing — protects performance.
        try {
          if (keyOf(location) !== lastUrlKey) return onMutate();
          if (wantApplied && !morphPresent()) return onMutate();
          if (!activeTransform) return;
          if (!reconcileCtrl.isCapped()) return onMutate();
          // Capped, but a reshape is active AND the page added nodes — a late
          // render/hydration/lazy-load. Re-arm so the reshape re-asserts onto the
          // new nodes (then re-caps once quiet). Gated on node additions so a
          // settled page never spins.
          if (addsNodes(records)) { reconcileCtrl.reset(); return onMutate(); }
        } catch (_) {}
      });
      const root = document.documentElement;
      if (root) obs.observe(root, { childList: true, subtree: true });
    } catch (_) { /* never break the page */ }
  }

  // Test-only navigation helpers (pure) for tests/reliability.test.mjs.
  M.__nav = { urlChanged, keyOf };
  M.__reconcile = { createController: createReconcileController };

  function start() {
    clearEarlyStyles();
    installSpaHooks();
    installMutationFallback();
    autoApply();
  }

  // run startup once the DOM is ready enough
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
