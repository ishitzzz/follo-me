/**
 * MorphTab Injected Script
 * Runs in page context to access rrweb recording.
 */
(function() {
  'use strict';

  if (window.__MORPHTAB_RECORDING__) return;

  if (typeof rrweb === 'undefined' || !rrweb.record) {
    console.error('[MorphTab] rrweb not available');
    return;
  }

  window.__MORPHTAB_RECORDING__ = true;

  window.__MORPHTAB_STOP__ = rrweb.record({
    emit: (event) => {
      window.postMessage({ type: 'RRWEB_EVENT', event }, '*');
    },
    sampling: {
      mousemove: 50,
      mouseInteraction: true,
      scroll: 150,
      input: 'last',
    },
    recordCanvas: false,
    recordCrossOriginIframes: false,
    maskAllInputs: false,
    maskInputOptions: { password: true },
  });

  console.log('[MorphTab] Recording started');
})();
