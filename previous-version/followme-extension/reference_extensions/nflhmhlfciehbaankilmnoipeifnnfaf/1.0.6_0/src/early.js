/*
 * early.js — document_start, FOUC killer.
 *
 * Runs as the FIRST content_scripts entry (run_at "document_start"), paired with
 * recipes.js loaded just before it in the same entry. It injects ONLY the saved
 * recipe's injectCSS rules as early as possible (before first paint) so the theme/
 * background lands without a flash of unstyled page. The full structural apply
 * (and undo/staleness handling) still happens later at document_idle in content.js,
 * which removes these early <style> nodes first to avoid double injection.
 *
 * Constraints:
 *  - ZERO dependency on window.MorphDSL (the idle bundle is not loaded yet).
 *  - Self-contained, never throws to the page (one big try/catch).
 *  - Touches the DOM only via document.documentElement (document.head/body may not
 *    exist yet at document_start).
 */
(function () {
  'use strict';
  try {
    if (window.__morphEarlyDone) return;
    window.__morphEarlyDone = true;

    const origin = location.origin;

    // Local, self-contained mirror of shared/dsl.js::neutralizeCss — kept private so
    // this file has ZERO dependency on the idle bundle at document_start. shared/dsl.js
    // is the SOURCE OF TRUTH and runs at SAVE time; this is defense in depth for the
    // stored value (e.g. a tampered or imported recipe). It mirrors ALL of the canonical
    // token-level removals so it is never weaker on them (the canonical additionally
    // runs a normalize + danger-scan net that stays save-time only).
    function neutralizeCss(css) {
      if (typeof css !== 'string') return '';
      return css
        .replace(/@import[^;]*;?/gi, '')
        .replace(/expression\s*\(/gi, 'void(')
        .replace(/behavior\s*:/gi, '/* behavior */:')
        .replace(/-moz-binding\s*:/gi, '/* binding */:')
        .replace(
          /url\(\s*(['"]?)(?:\/\*[\s\S]*?\*\/|\s)*(?:javascript|vbscript|mocha|livescript|data\s*:\s*text\/html|data\s*:\s*application)[^)]*\)/gi,
          'url($1about:blank#)'
        )
        .replace(/<\/style/gi, '<\\/style');
    }

    // Minimal pure path-glob match (mirror of recipes.js::pathMatches) so we don't
    // depend on recipes API being present for per-path scoping.
    function pathMatches(glob, pathname) {
      if (!glob || glob === '/*' || glob === '**') return true;
      if (typeof glob !== 'string') return true;
      const path = typeof pathname === 'string' ? pathname : '';
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
      try { return new RegExp('^' + re + '$').test(path); } catch (_) { return true; }
    }

    function recipeApplies(recipe) {
      if (!recipe) return false;
      const paths = recipe.paths;
      if (!Array.isArray(paths) || paths.length === 0) return true;
      return paths.some((g) => pathMatches(g, location.pathname));
    }

    function injectFromRecipe(recipe) {
      try {
        if (!recipe || recipe.enabled === false || recipe.stale === true) return;
        if (!recipeApplies(recipe)) return;
        const transform = recipe.transform;
        if (!transform || !Array.isArray(transform.ops)) return;
        const styles = [];
        for (const op of transform.ops) {
          if (!op || op.op !== 'injectCSS' || typeof op.css !== 'string') continue;
          const style = document.createElement('style');
          style.setAttribute('data-morph-style', 'morph-early');
          style.setAttribute('data-morph-early', '1');
          style.textContent = neutralizeCss(op.css);
          (document.head || document.documentElement).appendChild(style);
          styles.push(style);
        }
        // Hand off to the idle pipeline so it can remove these before the full apply.
        window.__morphEarlyStyles = (window.__morphEarlyStyles || []).concat(styles);
      } catch (_) { /* never break the page */ }
    }

    // Prefer the recipes API (loaded just before us in the same content_scripts entry).
    const api = window.Morph && window.Morph.recipes;
    if (api && typeof api.get === 'function') {
      Promise.resolve()
        .then(() => api.get(origin))
        .then((recipe) => injectFromRecipe(recipe))
        .catch(() => {});
    } else {
      // Fallback: read storage directly (origin-keyed map under 'morph:recipes').
      try {
        chrome.storage.local.get('morph:recipes', (data) => {
          try {
            if (chrome.runtime && chrome.runtime.lastError) return;
            const map = (data && data['morph:recipes']) || {};
            injectFromRecipe(map[origin]);
          } catch (_) { /* swallow */ }
        });
      } catch (_) { /* swallow */ }
    }
  } catch (_) { /* never break the page */ }
})();
