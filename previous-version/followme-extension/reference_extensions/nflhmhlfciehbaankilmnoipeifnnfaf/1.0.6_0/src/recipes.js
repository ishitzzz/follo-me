/*
 * Recipe manager — persists transforms per origin and exposes CRUD.
 * A recipe: { schemaVersion, origin, prompt, transform, createdAt, enabled, stale, paths? }
 * Storage: chrome.storage.local under key "morph:recipes" -> { [origin]: recipe }
 * Attaches to window.Morph.recipes.
 *
 * Backward compatibility: the popup (popup/popup.js) reads this storage layout
 * directly, keyed by origin, using top-level fields (prompt/createdAt/enabled/stale).
 * Migration here only ever ADDS fields and keeps the origin-keyed layout — never
 * rename/move/delete fields or it silently breaks the popup.
 */
(function () {
  'use strict';
  window.Morph = window.Morph || {};

  const KEY = 'morph:recipes';
  const SCHEMA_VERSION = 2;

  function getAllRaw() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (data) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve({}); return; }
          resolve((data && data[KEY]) || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  function setAll(map) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [KEY]: map }, () => {
          // Swallow quota / lastError: never reject (and never surface to the page).
          void (chrome.runtime && chrome.runtime.lastError);
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  // Serialize every read-modify-write so concurrent callers can't lose updates.
  // Rapid reshapes used to race (each read the recipe before the prior save landed),
  // so only the last op persisted and the page reverted on refresh. Each queued op
  // runs against freshly-read state, strictly in order; one failure never stalls it.
  let writeChain = Promise.resolve();
  function serialize(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  function originOf(url) {
    try { return new URL(url || location.href).origin; } catch { return location.origin; }
  }

  // ---- migration (idempotent; only adds fields) ----------------------------

  // Returns { recipe, changed } — never mutates the input.
  function migrateRecipe(r) {
    if (!r || typeof r !== 'object') return { recipe: r, changed: false };
    let changed = false;
    const out = Object.assign({}, r);
    if (out.schemaVersion === undefined || out.schemaVersion < SCHEMA_VERSION) {
      out.schemaVersion = SCHEMA_VERSION; changed = true;
    }
    if (out.origin === undefined) { out.origin = ''; changed = true; }
    if (out.enabled === undefined) { out.enabled = true; changed = true; }
    if (out.stale === undefined) { out.stale = false; changed = true; }
    if (out.createdAt === undefined) { out.createdAt = Date.now(); changed = true; }
    return { recipe: out, changed };
  }

  // Returns { map, changed } — new map with every value migrated.
  function migrateAll(map) {
    const out = {};
    let changed = false;
    for (const k of Object.keys(map || {})) {
      const res = migrateRecipe(map[k]);
      out[k] = res.recipe;
      if (res.changed) changed = true;
    }
    return { map: out, changed };
  }

  // Public getAll: lazily migrates and persists once if anything changed.
  async function getAll() {
    const raw = await getAllRaw();
    const { map, changed } = migrateAll(raw);
    if (changed) {
      // Lazy write-back. Guarded so a storage error never rejects.
      try { await setAll(map); } catch (_) { /* keep in-memory migrated map */ }
    }
    return map;
  }

  // ---- path-glob scoping ---------------------------------------------------

  /**
   * Pure glob match for a URL pathname.
   *  - '*'  matches any run of characters WITHIN a single path segment (no '/').
   *  - '**' matches across segments (any characters, including '/').
   * Anchored: the whole pathname must match.
   * A falsy glob, '/*' or '**' means "the whole origin" -> always true.
   */
  function pathMatches(glob, pathname) {
    if (!glob || glob === '/*' || glob === '**') return true;
    if (typeof glob !== 'string') return true;
    const path = typeof pathname === 'string' ? pathname : '';
    // Build an anchored regex. Handle '**' first so it isn't eaten by '*'.
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') { re += '.*'; i++; }
        else { re += '[^/]*'; }
      } else if ('\\^$.|?+()[]{}'.indexOf(c) !== -1) {
        re += '\\' + c;
      } else {
        re += c;
      }
    }
    try {
      return new RegExp('^' + re + '$').test(path);
    } catch (_) {
      return true; // never block applying on a bad glob
    }
  }

  /**
   * Pure: does this recipe apply to `url`?
   * Origin must match AND (no paths OR some path glob matches the pathname).
   * Absent/empty paths => whole-origin (every already-saved recipe keeps working).
   */
  function recipeAppliesTo(recipe, url) {
    if (!recipe) return false;
    let u;
    try { u = new URL(url || location.href); } catch (_) { return false; }
    const recipeOrigin = recipe.origin || '';
    if (recipeOrigin && recipeOrigin !== u.origin) return false;
    const paths = recipe.paths;
    if (!Array.isArray(paths) || paths.length === 0) return true;
    return paths.some((g) => pathMatches(g, u.pathname));
  }

  // ---- CRUD ----------------------------------------------------------------

  async function get(origin) {
    const all = await getAll();
    return all[origin || originOf()] || null;
  }

  function save(recipe) {
    return serialize(async () => {
      const all = await getAll();
      const origin = recipe.origin || originOf();
      const merged = Object.assign(
        { origin, enabled: true, stale: false, createdAt: Date.now() },
        all[origin] || {},
        recipe,
        { origin, schemaVersion: SCHEMA_VERSION }
      );
      // Persist optional per-path scoping when provided (array of glob strings).
      if (Array.isArray(recipe.paths)) merged.paths = recipe.paths.slice();
      all[origin] = merged;
      await setAll(all);
      return all[origin];
    });
  }

  // Atomically UNION `transform` onto the site's existing recipe (so successive
  // reshapes accumulate) and persist. Runs inside the serialized write queue, so
  // rapid reshapes can no longer lose ops. meta = { prompt }.
  function appendTransform(origin, transform, meta) {
    return serialize(async () => {
      const all = await getAll();
      const key = origin || originOf();
      const existing = all[key];
      const DSL = (typeof window !== 'undefined' && window.MorphDSL) || null;
      const mergedTransform = (existing && existing.transform && DSL && DSL.mergeTransforms)
        ? DSL.mergeTransforms(existing.transform, transform)
        : transform;
      const incoming = (meta && meta.prompt) || '';
      let prompt;
      if (existing && existing.prompt && incoming) {
        // The ops are unioned (deduped) by mergeTransforms, so keep the label in
        // sync: never re-append a prompt segment that is already present, which
        // also stops "dark mode + dark mode + ..." bloat on repeated reshapes.
        const dup = existing.prompt.split(' + ')
          .some((s) => s.trim().toLowerCase() === incoming.trim().toLowerCase());
        prompt = dup ? existing.prompt : String(existing.prompt + ' + ' + incoming).slice(0, 300);
      } else {
        prompt = incoming || (existing && existing.prompt) || '';
      }
      all[key] = Object.assign(
        { origin: key, createdAt: Date.now() },
        existing || {},
        { origin: key, prompt, transform: mergedTransform, enabled: true, stale: false, schemaVersion: SCHEMA_VERSION }
      );
      await setAll(all);
      return all[key];
    });
  }

  function remove(origin) {
    return serialize(async () => {
      const all = await getAll();
      delete all[origin || originOf()];
      await setAll(all);
    });
  }

  function setEnabled(origin, enabled) {
    return serialize(async () => {
      const all = await getAll();
      if (all[origin]) { all[origin].enabled = enabled; await setAll(all); }
    });
  }

  function markStale(origin, stale) {
    return serialize(async () => {
      const all = await getAll();
      if (all[origin]) { all[origin].stale = !!stale; await setAll(all); }
    });
  }

  async function list() {
    const all = await getAll();
    return Object.values(all).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  window.Morph.recipes = {
    get, save, appendTransform, remove, setEnabled, markStale, list, originOf, getAll,
    pathMatches, recipeAppliesTo, SCHEMA_VERSION,
  };
})();
