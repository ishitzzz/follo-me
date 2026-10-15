/*
 * Context extractor — serialize a compact, pruned view of the page so the model
 * can pick real selectors without shipping the whole DOM. Runs in the content script
 * (isolated world). Attaches to window.Morph.extractContext.
 */
(function () {
  'use strict';
  window.Morph = window.Morph || {};

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'path', 'meta', 'link',
    'br', 'head', 'iframe', 'canvas',
  ]);
  const MAX_NODES = 600;
  const MAX_DEPTH = 12;
  const MAX_CHILDREN = 14;     // cap repetitive lists
  const TEXT_PREVIEW = 50;
  const MAX_CHARS = 55000;

  function simpleId(id) {
    // only emit ids that are valid, stable-looking selectors
    return id && /^[A-Za-z][\w-]*$/.test(id) ? id : null;
  }

  function classes(el) {
    if (!el.classList || el.classList.length === 0) return [];
    return Array.from(el.classList)
      .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && c.length <= 40)
      .slice(0, 3);
  }

  function selectorHint(el) {
    const tag = el.tagName.toLowerCase();
    const id = simpleId(el.id);
    if (id) return `${tag}#${id}`;
    const cls = classes(el);
    return cls.length ? `${tag}.${cls.join('.')}` : tag;
  }

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) t += n.nodeValue;
      if (t.length > TEXT_PREVIEW * 2) break;
    }
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > TEXT_PREVIEW ? t.slice(0, TEXT_PREVIEW) + '…' : t;
  }

  function isVisible(el) {
    // cheap visibility filter; avoids dumping hidden subtrees
    if (el.hidden) return false;
    // Fast path: an inline display:none / visibility:hidden is a strict subset of
    // the computed value, so we can rule the node out WITHOUT forcing a
    // getComputedStyle reflow. The computed-style check below still catches
    // CSS-class / stylesheet-based hiding.
    const inline = el.style;
    if (inline && (inline.display === 'none' || inline.visibility === 'hidden')) return false;
    const view = el.ownerDocument.defaultView;
    const style = view && view.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  }

  function extractContext(root) {
    root = root || document.body || document.documentElement;
    const lines = [];
    let nodeCount = 0;
    let charCount = 0;
    let truncated = false;

    function walk(el, depth) {
      if (truncated || nodeCount >= MAX_NODES || depth > MAX_DEPTH) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : null;
      if (!tag || SKIP_TAGS.has(tag)) return;
      if (!isVisible(el)) return;

      nodeCount++;
      const indent = '  '.repeat(Math.min(depth, 10));
      const role = el.getAttribute && el.getAttribute('role');
      const aria = el.getAttribute && el.getAttribute('aria-label');
      const text = ownText(el);

      let line = indent + selectorHint(el);
      if (role) line += ` [role=${role}]`;
      if (aria) line += ` [aria-label="${aria.slice(0, 40)}"]`;
      if (text) line += ` "${text}"`;

      charCount += line.length + 1;
      if (charCount > MAX_CHARS) { truncated = true; return; }
      lines.push(line);

      const kids = Array.from(el.children || []);
      const shown = kids.slice(0, MAX_CHILDREN);
      for (const child of shown) walk(child, depth + 1);
      if (kids.length > shown.length) {
        lines.push(indent + `  …(+${kids.length - shown.length} more siblings)`);
      }
    }

    walk(root, 0);
    let out = lines.join('\n');
    if (truncated) out += '\n…(snapshot truncated)';
    return out;
  }

  window.Morph.extractContext = extractContext;
})();
