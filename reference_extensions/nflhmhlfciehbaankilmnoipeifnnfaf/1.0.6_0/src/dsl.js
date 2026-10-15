/*
 * Morph DSL — the contract between the model and the page.
 *
 * The model returns a Transform: { version, explanation, ops: [...] }.
 * This module:
 *   - validateTransform()  : structural validation + sanitization (PURE, no DOM)
 *   - applyTransform()     : interprets ops against a real document (needs a DOM)
 *   - undoTransform()      : reverses an applied transform (in-session)
 *
 * SECURITY: there is no code-execution op. addElement HTML is whitelist-sanitized,
 * injected CSS is neutralized, and no op can run script. The interpreter never trusts
 * the model — every op is validated/sanitized here, on our side.
 *
 * UMD: works as a Node module (tests) and as a browser global `MorphDSL` (content script).
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MorphDSL = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  // Op name -> required string fields (besides `op`). Optional fields handled per-op.
  const OP_SPECS = {
    injectCSS:   { fields: ['css'] },
    hide:        { fields: ['selector'] },
    show:        { fields: ['selector'] },
    remove:      { fields: ['selector'] },
    setStyle:    { fields: ['selector'], object: 'style' },
    setText:     { fields: ['selector', 'text'] },
    setAttr:     { fields: ['selector', 'name', 'value'] },
    addClass:    { fields: ['selector', 'class'] },
    removeClass: { fields: ['selector', 'class'] },
    move:        { fields: ['selector', 'target', 'position'] },
    addElement:  { fields: ['html', 'target', 'position'] },
    renderData:  { fields: ['target', 'position', 'chart', 'dataKey', 'x', 'y'] },
  };

  const POSITIONS = ['before', 'after', 'prepend', 'append'];

  const ALLOWED_TAGS = new Set([
    'div', 'span', 'p', 'a', 'ul', 'ol', 'li', 'img', 'b', 'i', 'strong', 'em',
    'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody',
    'tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'nav', 'aside',
    'main', 'small', 'code', 'pre', 'blockquote', 'figure', 'figcaption',
    'label', 'button', 'mark', 'time', 'sub', 'sup', 'caption', 'dl', 'dt', 'dd',
  ]);

  const ALLOWED_ATTRS = new Set([
    'class', 'id', 'style', 'href', 'src', 'alt', 'title', 'role', 'target',
    'rel', 'width', 'height', 'colspan', 'rowspan', 'datetime', 'type',
  ]);

  const SAFE_URL = /^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i;

  // Namespaces whose elements must be DROPPED with their whole subtree (none are
  // in ALLOWED_TAGS, and foreign content enables mXSS / <svg><script> leakage).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

  // Elements whose ENTIRE subtree must be dropped (not unwrapped): their text
  // content is executable/active in some context (script) or is a parsing trap
  // that re-activates on reparse (noscript/template-script, style breakout,
  // <title>/<textarea> mXSS). None are in ALLOWED_TAGS.
  const DROP_SUBTREE_TAGS = new Set([
    'script', 'style', 'noscript', 'noembed', 'noframes', 'iframe', 'frame',
    'frameset', 'object', 'embed', 'applet', 'title', 'textarea', 'xmp',
    'plaintext', 'listing',
  ]);

  // URL-bearing attribute names (used by both HTML sanitizer and setAttr guard).
  const URL_ATTRS = new Set(['href', 'src', 'srcset', 'xlink:href']);

  // Modest length caps (DoS hygiene; generous enough not to clip real payloads).
  const MAX_CSS = 200000;
  const MAX_HTML = 200000;
  const MAX_TEXT = 5000;
  const MAX_EXPLANATION = 500;
  const MAX_SELECTOR = 2000;
  const MAX_LABEL = 120;          // chart title cap
  const MAX_CHART_POINTS = 60;    // bars / points per chart
  // Trusted chart geometry — rendered by US via createElementNS, never the model.
  const CHART_W = 600, CHART_H = 280, CHART_PAD = 40;

  // ---- pure helpers --------------------------------------------------------

  function isString(v) { return typeof v === 'string'; }

  // Normalize a CSS string for DANGER DETECTION only (never used as output):
  // strip /*...*/ comments, decode CSS backslash escapes (\65 -> e, \6a -> j),
  // and collapse whitespace so 'expr/**/ession(' and '\65 xpression' are caught.
  function normalizeCssForScan(css) {
    if (!isString(css)) return '';
    let s = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
    // Decode CSS escapes: \<1-6 hex> (optional trailing ws) or \<char>
    s = s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (_, hex) {
      try {
        const cp = parseInt(hex, 16);
        if (cp > 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
      } catch (_e) { /* fall through */ }
      return '';
    });
    s = s.replace(/\\([^\r\n0-9a-fA-F])/g, '$1'); // \<char> -> char
    // strip control chars / NUL, collapse whitespace
    s = s.replace(/[\x00-\x20\x7f]+/g, ' ');
    return s.toLowerCase();
  }

  // Does the (already normalized) CSS contain a dangerous construct?
  function cssHasDanger(normalized) {
    return (
      /@import/.test(normalized) ||
      /expression\s*\(/.test(normalized) ||
      /behavior\s*:/.test(normalized) ||
      /-moz-binding/.test(normalized) ||
      /url\(\s*(['"]?)\s*(javascript|vbscript|mocha|livescript|data\s*:\s*text\/html|data\s*:\s*application)/.test(normalized) ||
      /(javascript|vbscript|mocha|livescript)\s*:/.test(normalized)
    );
  }

  // Shared CSS neutralizer. `mode` is 'css' (injectCSS) or 'style' (style attr /
  // setStyle value). When the normalized form trips cssHasDanger we strip the
  // offending tokens from the ORIGINAL text (comment-/escape-aware) rather than
  // rewriting valid styling. If we cannot prove it safe we blank it.
  function neutralizeCssValue(value, mode) {
    if (!isString(value)) return '';
    let out = value;
    // Token-level removals that are safe to apply unconditionally. Each pattern
    // tolerates intervening CSS comments/whitespace.
    const ws = '(?:\\s|/\\*[\\s\\S]*?\\*/)*';
    // @import ...;  -> drop
    out = out.replace(new RegExp('@import[^;]*;?', 'gi'), '');
    // expression( possibly comment-split: expr/**/ession(
    out = out.replace(new RegExp('e' + ws + 'x' + ws + 'p' + ws + 'r' + ws + 'e' + ws + 's' + ws + 's' + ws + 'i' + ws + 'o' + ws + 'n' + ws + '\\(', 'gi'), 'void(');
    // behavior: and -moz-binding:
    out = out.replace(new RegExp('behavior' + ws + ':', 'gi'), '/* behavior */:');
    out = out.replace(new RegExp('-moz-binding' + ws + ':', 'gi'), '/* binding */:');
    // url( <comments/ws> <dangerous-scheme> ...) -> url(about:blank#)
    out = out.replace(
      /url\(\s*(['"]?)((?:\/\*[\s\S]*?\*\/|\s)*)(javascript|vbscript|mocha|livescript|data\s*:\s*text\/html|data\s*:\s*application)[^)]*\)/gi,
      'url($1about:blank#)'
    );
    // bare scheme prefixes inside the value (style attr context)
    if (mode === 'style') {
      out = out.replace(/(javascript|vbscript|mocha|livescript)\s*:/gi, '');
    }
    // <style> breakout literal (injectCSS goes into a <style> textContent)
    if (mode === 'css') {
      out = out.replace(/<\/style/gi, '<\\/style');
    }
    // Final safety net: if normalization STILL detects danger, blank it out
    // rather than emit something that could execute.
    if (cssHasDanger(normalizeCssForScan(out))) return '';
    return out;
  }

  function neutralizeCss(css) {
    if (!isString(css)) return '';
    return neutralizeCssValue(css.slice(0, MAX_CSS), 'css');
  }

  function sanitizeStyleAttr(value) {
    if (!isString(value)) return '';
    return neutralizeCssValue(value, 'style');
  }

  // Normalize a URL value for SAFE_URL testing: strip control chars / tabs /
  // newlines / NUL that browsers ignore inside a scheme ('java\tscript:').
  function normalizeUrl(value) {
    if (!isString(value)) return '';
    // remove all control chars and whitespace anywhere (defeats java\tscript:,
    // leading spaces, embedded newlines) for the scheme test
    return value.replace(/[\x00-\x20\x7f]+/g, '');
  }

  function isSafeUrl(value) {
    return SAFE_URL.test(normalizeUrl(value));
  }

  // srcset is a comma-separated list of "<url> <descriptor>" candidates; every
  // candidate URL must be SAFE.
  function isSafeSrcset(value) {
    if (!isString(value)) return false;
    const candidates = value.split(',');
    for (const cand of candidates) {
      const url = cand.trim().split(/\s+/)[0];
      if (!url) continue;
      if (!isSafeUrl(url)) return false;
    }
    return true;
  }

  // Is this attribute name a URL-bearing one (after normalization)?
  function isUrlAttr(name) {
    const n = String(name).toLowerCase();
    return URL_ATTRS.has(n);
  }

  // Normalize an attribute name for the on* / namespaced checks: strip NUL and
  // whitespace that browsers may tolerate around the name.
  function normalizeAttrName(name) {
    return String(name).replace(/[\x00-\x20\x7f]+/g, '').toLowerCase();
  }

  function getDOMParser() {
    if (typeof DOMParser !== 'undefined') return new DOMParser();
    throw new Error('Morph: no DOMParser available in this environment');
  }

  /**
   * Whitelist-sanitize an HTML fragment. Returns a SAFE html string.
   * Requires a DOMParser (browser, or jsdom in tests).
   */
  function sanitizeHtml(html) {
    if (!isString(html) || html.trim() === '') return '';
    if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
    const parser = getDOMParser();
    const doc = parser.parseFromString('<body>' + html + '</body>', 'text/html');
    const body = doc.body;
    sanitizeNode(body, doc);
    return body.innerHTML;
  }

  function sanitizeNode(node, doc) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 8) { node.removeChild(child); continue; } // comments
      if (child.nodeType !== 1) continue;                              // keep text

      // Foreign content (SVG / MathML): DROP element AND its whole subtree.
      // None are in ALLOWED_TAGS, and unwrapping enables <svg><script>/mXSS and
      // xlink:href=javascript: leakage. namespaceURI is the reliable signal.
      const ns = child.namespaceURI;
      if (ns === SVG_NS || ns === MATHML_NS) { node.removeChild(child); continue; }

      const tag = child.tagName.toLowerCase();

      // Drop script-like / parsing-trap elements WITH their subtree (their text
      // is active or re-activates on reparse). Never unwrap these.
      if (DROP_SUBTREE_TAGS.has(tag)) { node.removeChild(child); continue; }

      // <template>: its real children live in a separate .content DocumentFragment
      // (off the childNodes tree). Sanitize that fragment, lift the surviving
      // children up into the document, then drop the (disallowed) <template>.
      if (tag === 'template' && child.content) {
        sanitizeNode(child.content, doc);
        while (child.content.firstChild) node.insertBefore(child.content.firstChild, child);
        // also handle any (rare) light-DOM children
        sanitizeNode(child, doc);
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        continue;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        // unwrap: keep sanitized children, drop the disallowed element itself.
        sanitizeNode(child, doc);
        const moved = [];
        while (child.firstChild) {
          const m = child.firstChild;
          node.insertBefore(m, child);
          moved.push(m);
        }
        node.removeChild(child);
        // Re-run sanitizeNode on the moved children in their new home so any
        // foreign/disallowed node that only became reachable after the unwrap is
        // re-evaluated (defense against reparenting-based mXSS).
        for (const m of moved) {
          if (m.nodeType === 1) {
            const mns = m.namespaceURI;
            if (mns === SVG_NS || mns === MATHML_NS) { node.removeChild(m); continue; }
            const mtag = m.tagName.toLowerCase();
            if (DROP_SUBTREE_TAGS.has(mtag)) { node.removeChild(m); continue; }
            if (!ALLOWED_TAGS.has(mtag)) {
              sanitizeNode(m, doc);
              while (m.firstChild) node.insertBefore(m.firstChild, m);
              node.removeChild(m);
            }
          }
        }
        continue;
      }
      // scrub attributes
      for (const attr of Array.from(child.attributes)) {
        const rawName = attr.name;
        const name = rawName.toLowerCase();
        // strip ALL namespaced attrs (xlink:href, xml:*, etc.) — they are never
        // whitelisted and carry foreign-content URL/script vectors.
        if (name.indexOf(':') !== -1) { child.removeAttribute(rawName); continue; }
        // normalize for on* detection: remove NUL/whitespace browsers may tolerate
        const normName = normalizeAttrName(rawName);
        if (normName.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
          child.removeAttribute(rawName);
          continue;
        }
        if (name === 'href' || name === 'src') {
          if (!isSafeUrl(attr.value)) { child.removeAttribute(rawName); continue; }
        }
        if (name === 'srcset') {
          // not currently whitelisted, but if it ever is, guard every candidate.
          if (!isSafeSrcset(attr.value)) { child.removeAttribute(rawName); continue; }
        }
        if (name === 'style') {
          child.setAttribute('style', sanitizeStyleAttr(attr.value));
        }
        if (name === 'target' && child.getAttribute('target') === '_blank') {
          child.setAttribute('rel', 'noopener noreferrer');
        }
      }
      sanitizeNode(child, doc);
    }
  }

  // ---- validation ----------------------------------------------------------

  /**
   * Validate + sanitize a raw transform object from the model.
   * Returns { ok, transform, errors[], skipped[] }.
   * Invalid ops are DROPPED (not fatal) and reported in `skipped`.
   * Pure except sanitizeHtml needs a DOMParser; callers in Node tests provide jsdom.
   */
  function validateTransform(raw) {
    const errors = [];
    const skipped = [];

    if (!raw || typeof raw !== 'object') {
      return { ok: false, transform: null, errors: ['transform is not an object'], skipped };
    }
    if (!Array.isArray(raw.ops)) {
      return { ok: false, transform: null, errors: ['transform.ops must be an array'], skipped };
    }

    const cleanOps = [];
    raw.ops.forEach((op, i) => {
      const reason = opError(op);
      if (reason) { skipped.push({ index: i, op: op && op.op, reason }); return; }
      cleanOps.push(sanitizeOp(op));
    });

    const transform = {
      version: SCHEMA_VERSION,
      explanation: isString(raw.explanation) ? raw.explanation.slice(0, MAX_EXPLANATION) : '',
      ops: cleanOps,
    };
    return { ok: cleanOps.length > 0, transform, errors, skipped };
  }

  function opError(op) {
    if (!op || typeof op !== 'object') return 'op is not an object';
    const spec = OP_SPECS[op.op];
    if (!spec) return 'unknown op: ' + op.op;
    for (const f of spec.fields) {
      if (!isString(op[f])) return `missing/invalid field "${f}"`;
    }
    if (op.op === 'move' || op.op === 'addElement') {
      if (!POSITIONS.includes(op.position)) return 'invalid position';
    }
    if (spec.object && (typeof op[spec.object] !== 'object' || op[spec.object] === null)) {
      return `missing/invalid object "${spec.object}"`;
    }
    // Fail-fast guard for obviously malformed/oversized selectors. Does NOT
    // reject valid CSS selectors used elsewhere ('.promoted', '#content',
    // 'article.post', '*'); only catches non-string / absurdly long values.
    if (spec.fields.includes('selector') && !isValidSelectorShape(op.selector)) {
      return 'invalid selector';
    }
    if (op.op === 'move' && !isValidSelectorShape(op.target)) {
      return 'invalid target selector';
    }
    // setAttr: reject event-handler attribute NAMES and enforce the SAME
    // attribute whitelist that sanitizeHtml uses, so an attr that would be
    // stripped inside addElement HTML (srcdoc, formaction, action, ...) cannot
    // be smuggled in via setAttr onto live elements.
    if (op.op === 'setAttr') {
      const n = normalizeAttrName(op.name);
      if (n.startsWith('on')) return 'event-handler attr blocked';
      if (!ALLOWED_ATTRS.has(n)) return 'attr not allowed: ' + n;
    }
    // renderData: chart type + position must be from the fixed sets. Field
    // mappings (dataKey/x/y) are validated as strings via spec.fields above; the
    // actual numbers come from caller-attached data at apply time, never the model.
    if (op.op === 'renderData') {
      if (!POSITIONS.includes(op.position)) return 'invalid position';
      if (op.chart !== 'bar' && op.chart !== 'line') return 'invalid chart type';
    }
    return null;
  }

  // Lightweight selector sanity check. We deliberately accept anything that is a
  // reasonably-sized string and reject only clearly-bogus inputs (empty, huge,
  // or containing characters that can never appear in a CSS selector). The
  // authoritative validity check still happens at apply time via
  // querySelectorAll (which throws -> caught per-op), so this never changes the
  // "bad selector fails that op only" contract — it just fails such ops earlier.
  function isValidSelectorShape(sel) {
    if (!isString(sel)) return false;
    if (sel.length === 0 || sel.length > MAX_SELECTOR) return false;
    // NOTE: we intentionally do NOT reject angle brackets or other syntactically
    // invalid selectors here. The existing contract ("bad selector fails that op
    // only") requires a malformed selector like '<<<invalid>>>' to PASS validate
    // and FAIL at apply time via querySelectorAll's throw. We only fail fast on
    // non-string / empty / absurdly long values, which can never be valid.
    return true;
  }

  // Bound + type-check a self-healing anchors descriptor from a (semi-trusted,
  // locally-stored) recipe. Drops unknown fields and caps sizes.
  function sanitizeAnchors(arr) {
    const out = [];
    for (const a of arr.slice(0, 10)) {
      if (!a || typeof a !== 'object') continue;
      const s = {};
      if (typeof a.tag === 'string') s.tag = a.tag.slice(0, 40).toLowerCase();
      if (typeof a.id === 'string') s.id = a.id.slice(0, 200);
      if (typeof a.role === 'string') s.role = a.role.slice(0, 80);
      if (typeof a.aria === 'string') s.aria = a.aria.slice(0, 200);
      if (typeof a.text === 'string') s.text = a.text.slice(0, 120);
      if (Array.isArray(a.classes)) s.classes = a.classes.filter((c) => typeof c === 'string').slice(0, 8).map((c) => c.slice(0, 80));
      if (typeof a.nthOfType === 'number' && isFinite(a.nthOfType)) s.nthOfType = a.nthOfType;
      out.push(s);
    }
    return out;
  }

  function sanitizeOp(op) {
    const out = { op: op.op };
    const spec = OP_SPECS[op.op];
    for (const f of spec.fields) out[f] = op[f];
    if (op.op === 'injectCSS') out.css = neutralizeCss(op.css);
    if (op.op === 'addElement') out.html = sanitizeHtml(String(op.html).slice(0, MAX_HTML));
    if (op.op === 'setStyle') {
      const style = {};
      for (const k of Object.keys(op.style)) {
        if (isString(op.style[k]) || typeof op.style[k] === 'number') {
          style[k] = sanitizeStyleAttr(String(op.style[k]));
        }
      }
      out.style = style;
    }
    if (op.op === 'setText') out.text = String(op.text).slice(0, MAX_TEXT);
    if (op.op === 'renderData') out.title = isString(op.title) ? op.title.slice(0, MAX_LABEL) : '';
    if (op.op === 'setAttr') {
      // Name is already whitelisted in opError. Sanitize the VALUE for
      // URL-bearing attributes and for the style attribute (apply-side never
      // checks values), matching how sanitizeHtml treats the same attributes.
      if (isUrlAttr(out.name)) {
        const ok = out.name.toLowerCase() === 'srcset' ? isSafeSrcset(out.value) : isSafeUrl(out.value);
        if (!ok) out.value = '';
      }
      if (normalizeAttrName(out.name) === 'style') out.value = sanitizeStyleAttr(String(out.value));
    }
    // Preserve a self-healing descriptor if the (saved) op carries one.
    if (Array.isArray(op.anchors)) out.anchors = sanitizeAnchors(op.anchors);
    return out;
  }

  // ---- application (needs a DOM) -------------------------------------------

  const STYLE_GROUP_ATTR = 'data-morph-style';

  /**
   * Apply a (validated) transform to `doc`. Returns a handle:
   *   { undos: [fn...], applied: n, failed: n, errors: [...] }
   * Each op is wrapped in try/catch so one bad op never aborts the rest.
   */
  function applyTransform(transform, doc, opts) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('Morph: applyTransform needs a document');
    const groupId = (opts && opts.groupId) || 'morph';
    const data = (opts && opts.data) || {};
    const undos = [];
    let applied = 0, failed = 0;
    const errors = [];

    for (const op of transform.ops) {
      try {
        const undo = applyOp(op, doc, groupId, data);
        // null == the op matched nothing (e.g. a selector whose targets haven't
        // rendered yet): a MISS, not an applied op and not a failure. This keeps
        // `applied` honest so callers don't set a phantom "it's applied" sentinel.
        if (undo === null) continue;
        if (undo) undos.push(undo);
        applied++;
      } catch (e) {
        failed++;
        errors.push({ op: op.op, message: String(e && e.message || e) });
      }
    }
    return { undos, applied, failed, errors };
  }

  function undoTransform(handle) {
    if (!handle || !Array.isArray(handle.undos)) return;
    // reverse order so structural moves unwind cleanly
    for (let i = handle.undos.length - 1; i >= 0; i--) {
      try { handle.undos[i](); } catch (_) { /* best effort */ }
    }
    handle.undos.length = 0;
  }

  function selectAll(doc, selector) {
    // throws on invalid selector -> caught by applyTransform
    return Array.from(doc.querySelectorAll(selector));
  }

  // Element resolution for applyOp. An op carrying an `anchors` descriptor uses
  // the self-healing resolver (survives selector rot). An op WITHOUT anchors keeps
  // the exact legacy behavior: selectAll throws on an invalid selector so that op
  // fails (the "bad selector fails that op only" contract) — nothing changes.
  function resolveEls(doc, op) {
    if (Array.isArray(op.anchors) && op.anchors.length) return resolveSelector(doc, op).els;
    return selectAll(doc, op.selector);
  }

  function applyOp(op, doc, groupId, data) {
    switch (op.op) {
      case 'injectCSS': {
        const style = doc.createElement('style');
        style.setAttribute(STYLE_GROUP_ATTR, groupId);
        style.textContent = op.css; // textContent: no breakout
        (doc.head || doc.documentElement).appendChild(style);
        return () => style.remove();
      }
      case 'hide':
      case 'show': {
        const val = op.op === 'hide' ? 'none' : '';
        const els = resolveEls(doc, op);
        if (!els.length) return null; // matched nothing — a miss, not an applied op
        const prev = els.map((el) => el.style.display);
        els.forEach((el) => {
          if (op.op === 'show' && val === '') el.style.removeProperty('display');
          else el.style.setProperty('display', val, 'important');
        });
        return () => els.forEach((el, i) => { el.style.display = prev[i]; });
      }
      case 'remove': {
        const els = resolveEls(doc, op);
        if (!els.length) return null; // nothing to remove yet — a miss, not applied
        const markers = els.map((el) => {
          const marker = doc.createComment('morph-removed');
          el.parentNode && el.parentNode.replaceChild(marker, el);
          return { el, marker };
        });
        return () => markers.forEach(({ el, marker }) => {
          marker.parentNode && marker.parentNode.replaceChild(el, marker);
        });
      }
      case 'setStyle': {
        const els = resolveEls(doc, op);
        if (!els.length) return null;
        const keys = Object.keys(op.style);
        const prev = els.map((el) => keys.map((k) => el.style.getPropertyValue(k)));
        els.forEach((el) => keys.forEach((k) => el.style.setProperty(k, op.style[k], 'important')));
        return () => els.forEach((el, i) => keys.forEach((k, j) => {
          if (prev[i][j]) el.style.setProperty(k, prev[i][j]); else el.style.removeProperty(k);
        }));
      }
      case 'setText': {
        // Refuse to write into active-content / reparse-trap elements: setting the
        // textContent of a live <style> IS the stylesheet (arbitrary CSS injection
        // that bypasses neutralizeCss), and <script>/<title>/<textarea> are mXSS
        // reparse traps. These are never legitimate setText targets. Skip them;
        // apply to the safe elements only.
        const els = resolveEls(doc, op)
          .filter((el) => !DROP_SUBTREE_TAGS.has(el.tagName.toLowerCase()));
        if (!els.length) return null;
        const prev = els.map((el) => el.textContent);
        els.forEach((el) => { el.textContent = op.text; });
        return () => els.forEach((el, i) => { el.textContent = prev[i]; });
      }
      case 'setAttr': {
        const els = resolveEls(doc, op);
        if (op.name.toLowerCase().startsWith('on')) throw new Error('event-handler attr blocked');
        if (!els.length) return null;
        const prev = els.map((el) => (el.hasAttribute(op.name) ? el.getAttribute(op.name) : null));
        els.forEach((el) => el.setAttribute(op.name, op.value));
        return () => els.forEach((el, i) => {
          if (prev[i] === null) el.removeAttribute(op.name); else el.setAttribute(op.name, prev[i]);
        });
      }
      case 'addClass':
      case 'removeClass': {
        const els = resolveEls(doc, op);
        if (!els.length) return null;
        const had = els.map((el) => el.classList.contains(op.class));
        els.forEach((el) => el.classList[op.op === 'addClass' ? 'add' : 'remove'](op.class));
        return () => els.forEach((el, i) => {
          if (op.op === 'addClass' && !had[i]) el.classList.remove(op.class);
          if (op.op === 'removeClass' && had[i]) el.classList.add(op.class);
        });
      }
      case 'move': {
        const els = resolveEls(doc, op);
        const target = doc.querySelector(op.target);
        if (!target) throw new Error('move target not found: ' + op.target);
        const origins = els.map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
        els.forEach((el) => insertRelative(el, target, op.position));
        return () => origins.forEach(({ el, parent, next }) => {
          if (parent) parent.insertBefore(el, next);
        });
      }
      case 'addElement': {
        const target = doc.querySelector(op.target);
        if (!target) throw new Error('addElement target not found: ' + op.target);
        const tpl = doc.createElement('template');
        tpl.innerHTML = op.html; // already sanitized
        const nodes = Array.from(tpl.content ? tpl.content.childNodes : tpl.childNodes);
        const wrapper = doc.createElement('div');
        wrapper.setAttribute('data-morph-added', groupId);
        nodes.forEach((n) => wrapper.appendChild(n));
        insertRelative(wrapper, target, op.position);
        return () => wrapper.remove();
      }
      case 'renderData': {
        const target = doc.querySelector(op.target);
        if (!target) throw new Error('renderData target not found: ' + op.target);
        const svg = buildChart(doc, op, data);   // built by US from attached data
        const wrapper = doc.createElement('div');
        wrapper.setAttribute('data-morph-added', groupId);
        wrapper.appendChild(svg);
        insertRelative(wrapper, target, op.position);
        return () => wrapper.remove();
      }
      default:
        throw new Error('unhandled op: ' + op.op);
    }
  }

  function insertRelative(node, target, position) {
    switch (position) {
      case 'before': target.parentNode.insertBefore(node, target); break;
      case 'after': target.parentNode.insertBefore(node, target.nextSibling); break;
      case 'prepend': target.insertBefore(node, target.firstChild); break;
      case 'append': target.appendChild(node); break;
    }
  }

  // ---- trusted chart rendering (renderData) --------------------------------
  // Built entirely by US from typed records the CALLER attached (opts.data).
  // The model supplies only the chart type and field names; every value is
  // coerced through Number() before it touches a numeric attribute, and every
  // label/title is set via textContent. No model- or data-supplied string is
  // ever parsed as markup (createElementNS only, never innerHTML).
  function svgEl(doc, name, attrs) {
    const el = doc.createElementNS(SVG_NS, name);
    for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
    return el;
  }

  function coerceNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function buildChart(doc, op, data) {
    const ds = (data && typeof data === 'object') ? data[op.dataKey] : null;
    const records = (ds && Array.isArray(ds.records)) ? ds.records.slice(0, MAX_CHART_POINTS) : null;
    if (!records || records.length === 0) throw new Error('renderData: no records for ' + op.dataKey);
    const points = records.map((r) => ({
      label: String((r && r[op.x] != null) ? r[op.x] : '').slice(0, 40),
      value: coerceNum(r && r[op.y]),
    }));
    const maxV = Math.max(1, ...points.map((p) => p.value));
    const n = points.length;
    const innerW = CHART_W - 2 * CHART_PAD;
    const top = op.title ? 34 : 12;
    const bottom = CHART_H - CHART_PAD;
    const plotH = bottom - top;

    const svg = svgEl(doc, 'svg', {
      width: CHART_W, height: CHART_H, viewBox: '0 0 ' + CHART_W + ' ' + CHART_H,
      'data-morph-chart': op.chart, 'font-family': 'sans-serif',
    });
    if (op.title) {
      const t = svgEl(doc, 'text', { x: CHART_PAD, y: 22, 'font-size': 16, fill: 'currentColor' });
      t.textContent = op.title;                 // text only — never markup
      svg.appendChild(t);
    }

    if (op.chart === 'line') {
      const step = n > 1 ? innerW / (n - 1) : 0;
      const coords = points.map((p, i) =>
        (CHART_PAD + i * step).toFixed(1) + ',' + (bottom - (p.value / maxV) * plotH).toFixed(1)
      ).join(' ');
      svg.appendChild(svgEl(doc, 'polyline', { points: coords, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    } else {
      const bw = innerW / n;
      points.forEach((p, i) => {
        const h = (p.value / maxV) * plotH;
        svg.appendChild(svgEl(doc, 'rect', {
          x: (CHART_PAD + i * bw + bw * 0.1).toFixed(1), y: (bottom - h).toFixed(1),
          width: (bw * 0.8).toFixed(1), height: h.toFixed(1), fill: 'currentColor',
        }));
      });
    }

    // x-axis labels (text only)
    points.forEach((p, i) => {
      const x = op.chart === 'line'
        ? CHART_PAD + (n > 1 ? innerW / (n - 1) : 0) * i
        : CHART_PAD + (innerW / n) * i + (innerW / n) / 2;
      const lab = svgEl(doc, 'text', { x: x.toFixed(1), y: CHART_H - 14, 'font-size': 10, fill: 'currentColor', 'text-anchor': 'middle' });
      lab.textContent = p.label;                // text only — never markup
      svg.appendChild(lab);
    });
    return svg;
  }

  // ---- reconcile: idempotent re-assertion (survive SPA re-renders) ---------
  // Re-applies each element-targeting op ONLY to matching nodes that don't yet
  // carry that op's marker (the freshly-rendered ones), and re-adds a removed
  // injectCSS <style>. Safe to call repeatedly. Returns { reapplied, undos };
  // reapplied counts ops that touched >=1 new node (0 == stable — drives a hard
  // cap in the caller so a constantly-mutating page can't spin the CPU).
  const RECON_ATTR = 'data-morph-r';        // space-separated op tokens on touched els
  const RECON_CSS_ATTR = 'data-morph-rcss'; // marks an injected style tag (value = token)

  function reconHas(el, token) {
    return (el.getAttribute(RECON_ATTR) || '').split(/\s+/).indexOf(token) !== -1;
  }
  function reconAdd(el, token) {
    const v = el.getAttribute(RECON_ATTR) || '';
    el.setAttribute(RECON_ATTR, v ? v + ' ' + token : token);
  }
  function reconDel(el, token) {
    const v = (el.getAttribute(RECON_ATTR) || '').split(/\s+/).filter((t) => t && t !== token);
    if (v.length) el.setAttribute(RECON_ATTR, v.join(' ')); else el.removeAttribute(RECON_ATTR);
  }
  function unmarked(doc, selector, token) {
    return selectAll(doc, selector).filter((el) => !reconHas(el, token));
  }

  function reconcile(transform, doc, opts) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('Morph: reconcile needs a document');
    if (!transform || !Array.isArray(transform.ops)) return { reapplied: 0, undos: [] };
    const groupId = (opts && opts.groupId) || 'morph';
    const undos = [];
    let reapplied = 0;
    transform.ops.forEach((op, i) => {
      try {
        const r = reassertOp(op, doc, groupId, i);
        if (r && r.touched > 0) { reapplied++; if (r.undo) undos.push(r.undo); }
      } catch (_) { /* per-op safety — never break the page */ }
    });
    return { reapplied, undos };
  }

  function reassertOp(op, doc, groupId, idx) {
    const token = groupId + ':' + idx;
    switch (op.op) {
      case 'injectCSS': {
        if (doc.querySelector('style[' + RECON_CSS_ATTR + '="' + token + '"]')) return { touched: 0 };
        const style = doc.createElement('style');
        style.setAttribute(RECON_CSS_ATTR, token);
        style.setAttribute(STYLE_GROUP_ATTR, groupId);
        style.textContent = op.css; // textContent: no breakout
        (doc.head || doc.documentElement).appendChild(style);
        return { touched: 1, undo: () => style.remove() };
      }
      case 'hide':
      case 'show': {
        const els = unmarked(doc, op.selector, token);
        if (!els.length) return { touched: 0 };
        const val = op.op === 'hide' ? 'none' : '';
        const prev = els.map((el) => el.style.display);
        els.forEach((el) => {
          if (op.op === 'show' && val === '') el.style.removeProperty('display');
          else el.style.setProperty('display', val, 'important');
          reconAdd(el, token);
        });
        return { touched: els.length, undo: () => els.forEach((el, i) => { el.style.display = prev[i]; reconDel(el, token); }) };
      }
      case 'setStyle': {
        const els = unmarked(doc, op.selector, token);
        if (!els.length) return { touched: 0 };
        const keys = Object.keys(op.style);
        const prev = els.map((el) => keys.map((k) => el.style.getPropertyValue(k)));
        els.forEach((el) => { keys.forEach((k) => el.style.setProperty(k, op.style[k], 'important')); reconAdd(el, token); });
        return {
          touched: els.length,
          undo: () => els.forEach((el, i) => { keys.forEach((k, j) => { if (prev[i][j]) el.style.setProperty(k, prev[i][j]); else el.style.removeProperty(k); }); reconDel(el, token); }),
        };
      }
      case 'setText': {
        const els = unmarked(doc, op.selector, token).filter((el) => !DROP_SUBTREE_TAGS.has(el.tagName.toLowerCase()));
        if (!els.length) return { touched: 0 };
        const prev = els.map((el) => el.textContent);
        els.forEach((el) => { el.textContent = op.text; reconAdd(el, token); });
        return { touched: els.length, undo: () => els.forEach((el, i) => { el.textContent = prev[i]; reconDel(el, token); }) };
      }
      case 'setAttr': {
        if (op.name.toLowerCase().startsWith('on')) return { touched: 0 };
        const els = unmarked(doc, op.selector, token);
        if (!els.length) return { touched: 0 };
        const prev = els.map((el) => (el.hasAttribute(op.name) ? el.getAttribute(op.name) : null));
        els.forEach((el) => { el.setAttribute(op.name, op.value); reconAdd(el, token); });
        return { touched: els.length, undo: () => els.forEach((el, i) => { if (prev[i] === null) el.removeAttribute(op.name); else el.setAttribute(op.name, prev[i]); reconDel(el, token); }) };
      }
      case 'addClass':
      case 'removeClass': {
        const els = unmarked(doc, op.selector, token);
        if (!els.length) return { touched: 0 };
        const had = els.map((el) => el.classList.contains(op.class));
        els.forEach((el) => { el.classList[op.op === 'addClass' ? 'add' : 'remove'](op.class); reconAdd(el, token); });
        return {
          touched: els.length,
          undo: () => els.forEach((el, i) => { if (op.op === 'addClass' && !had[i]) el.classList.remove(op.class); if (op.op === 'removeClass' && had[i]) el.classList.add(op.class); reconDel(el, token); }),
        };
      }
      case 'remove': {
        // Re-remove LIVE matches the page re-rendered / hydrated / lazy-loaded
        // after we first removed them — the dominant revert-on-refresh case on
        // SPA pages. Removal deletes the node (no per-node marker is possible),
        // so re-query each tick and remove whatever currently matches.
        const els = selectAll(doc, op.selector);
        if (!els.length) return { touched: 0 };
        const removed = els.map((el) => ({ el, parent: el.parentNode, next: el.nextSibling }));
        els.forEach((el) => { if (el.parentNode) el.parentNode.removeChild(el); });
        return {
          touched: els.length,
          undo: () => removed.forEach(({ el, parent, next }) => { try { if (parent) parent.insertBefore(el, next); } catch (_) { /* node moved */ } }),
        };
      }
      // Other structural ops (move / addElement / renderData) add wrappers that
      // survive most partial re-renders; full re-add support is a follow-up.
      default:
        return { touched: 0 };
    }
  }

  // ---- self-healing selectors (the moat) -----------------------------------
  // A recipe can store a multi-signal descriptor per targeted element. When the
  // literal selector stops matching (class-hash rotation / redeploy),
  // resolveSelector finds the best current match via a scoring cascade and
  // rebinds ONLY above a confidence threshold — never silently onto the wrong
  // element (a wrong rebind is worse than going stale).
  const HEAL_THRESHOLD = 0.5;
  const HEAL_MAX_CANDIDATES = 3000;

  function normText(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().toLowerCase(); }

  function nthOfType(el) {
    const parent = el.parentNode;
    if (!parent || !parent.children) return 0;
    const tag = el.tagName;
    let i = 0;
    for (const sib of parent.children) { if (sib.tagName === tag) { i++; if (sib === el) return i; } }
    return 0;
  }

  // Capture a resilient descriptor of `el` (called at recipe-save time).
  function captureAnchor(el) {
    if (!el || el.nodeType !== 1) return null;
    const a = { tag: el.tagName.toLowerCase() };
    if (el.id) a.id = el.id;
    const role = el.getAttribute && el.getAttribute('role');
    if (role) a.role = role;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) a.aria = aria;
    const text = normText(el.textContent).slice(0, 80);
    if (text) a.text = text;
    a.classes = (el.classList ? Array.from(el.classList) : []).slice(0, 6);
    a.nthOfType = nthOfType(el);
    return a;
  }

  // Score 0..1: how well `el` matches `anchor`. Only weighs signals the anchor has.
  function scoreAnchor(el, anchor) {
    const W = { tag: 1, id: 4, role: 3, aria: 3, text: 5, cls: 2 };
    let score = 0, max = 0;
    max += W.tag; if (anchor.tag && el.tagName.toLowerCase() === anchor.tag) score += W.tag;
    if (anchor.id) { max += W.id; if (el.id === anchor.id) score += W.id; }
    if (anchor.role) { max += W.role; if ((el.getAttribute && el.getAttribute('role')) === anchor.role) score += W.role; }
    if (anchor.aria) { max += W.aria; if ((el.getAttribute && el.getAttribute('aria-label')) === anchor.aria) score += W.aria; }
    if (anchor.text) {
      max += W.text;
      const ct = normText(el.textContent).slice(0, 200);
      if (ct === anchor.text) score += W.text;
      else if (ct && ct.indexOf(anchor.text) !== -1) score += W.text * 0.5;
    }
    if (anchor.classes && anchor.classes.length) {
      max += W.cls;
      const have = anchor.classes.filter((c) => el.classList && el.classList.contains(c)).length;
      score += W.cls * (have / anchor.classes.length);
    }
    return max > 0 ? score / max : 0;
  }

  function findByAnchor(doc, anchor) {
    if (!anchor || typeof anchor !== 'object') return null;
    let candidates;
    try { candidates = Array.from(doc.querySelectorAll(anchor.tag || '*')); }
    catch (_) { try { candidates = Array.from(doc.querySelectorAll('*')); } catch (_e) { return null; } }
    if (candidates.length > HEAL_MAX_CANDIDATES) candidates = candidates.slice(0, HEAL_MAX_CANDIDATES);
    let best = null, bestScore = 0;
    for (const el of candidates) {
      const s = scoreAnchor(el, anchor);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return bestScore >= HEAL_THRESHOLD ? best : null;
  }

  // Resolve op.selector to elements. Literal first; if nothing matches, heal via
  // op.anchors. Returns { els, healed }. Never throws.
  function resolveSelector(doc, op) {
    let els = [];
    try { els = Array.from(doc.querySelectorAll(op.selector)); } catch (_) { els = []; }
    if (els.length) return { els, healed: false };
    const anchors = Array.isArray(op.anchors) ? op.anchors : null;
    if (!anchors || !anchors.length) return { els: [], healed: false };
    const seen = new Set();
    const healed = [];
    for (const anchor of anchors) {
      const el = findByAnchor(doc, anchor);
      if (el && !seen.has(el)) { seen.add(el); healed.push(el); }
    }
    return { els: healed, healed: healed.length > 0 };
  }

  // Enrich a transform's selector-bearing ops with anchors captured from `doc`
  // (called at recipe-save time). Ops without a selector, with no current match,
  // or that already carry anchors are left untouched. Returns a new transform.
  function withAnchors(transform, doc) {
    if (!transform || !Array.isArray(transform.ops) || !doc) return transform;
    const ops = transform.ops.map((op) => {
      if (!op || typeof op.selector !== 'string' || Array.isArray(op.anchors)) return op;
      let matches = [];
      try { matches = Array.from(doc.querySelectorAll(op.selector)).slice(0, 5); } catch (_) { matches = []; }
      if (!matches.length) return op;
      const anchors = matches.map((el) => captureAnchor(el)).filter(Boolean);
      return anchors.length ? Object.assign({}, op, { anchors }) : op;
    });
    return Object.assign({}, transform, { ops });
  }

  // Union the ops of two transforms so a NEW reshape stacks on top of prior ones
  // instead of replacing them ("remove images" then "remove text" => both gone).
  // Pure: never mutates either input. Carries the latest transform's metadata.
  function mergeTransforms(existing, incoming) {
    const exOps = (existing && Array.isArray(existing.ops)) ? existing.ops : [];
    const inOps = (incoming && Array.isArray(incoming.ops)) ? incoming.ops : [];
    const base = (incoming && typeof incoming === 'object') ? incoming : (existing || {});
    return Object.assign({}, base, { ops: exOps.concat(inOps) });
  }

  return {
    SCHEMA_VERSION,
    OP_SPECS,
    POSITIONS,
    validateTransform,
    sanitizeHtml,
    neutralizeCss,
    applyTransform,
    undoTransform,
    reconcile,
    captureAnchor,
    resolveSelector,
    withAnchors,
    mergeTransforms,
  };
});
