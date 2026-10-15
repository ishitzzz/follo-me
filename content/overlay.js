/**
 * FolloMe — Smart Contextual Annotations & Guardrails (Phase 2)
 * Strictly follows TipTour UI design for cursors and overlays.
 */
(() => {
  if (window.__follomeOverlayLoaded) return;
  window.__follomeOverlayLoaded = true;

  let shadowContainer = null;
  let cursorEl = null;
  let svgLayer = null;
  let safetyGlass = null;
  let tooltipEl = null;
  let currentTarget = null;
  
  // Create TipTour Ghost Cursor and Overlay
  function initOverlay() {
    if (shadowContainer) return;

    // Safety Glass: Prevents user interaction while agent is drawing/executing
    safetyGlass = document.createElement('div');
    safetyGlass.id = 'follome-safety-glass';
    safetyGlass.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      z-index: 2147483646; pointer-events: none; background: transparent;
    `;
    document.body.appendChild(safetyGlass);

    shadowContainer = document.createElement('div');
    shadowContainer.id = 'follome-tiptour-overlay';
    shadowContainer.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      z-index: 2147483647; pointer-events: none;
    `;
    
    // Attach Shadow DOM to prevent CSS bleeding
    const shadowRoot = shadowContainer.attachShadow({ mode: 'open' });
    
    // TipTour SVG Cursor
    cursorEl = document.createElement('div');
    cursorEl.style.cssText = `
      position: absolute; top: -100px; left: -100px;
      width: 28px; height: 28px;
      transition: transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
      will-change: transform;
    `;
    cursorEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="#0F172A" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.04c.45 0 .67-.54.35-.85L6.35 3.21a.5.5 0 0 0-.85.35Z" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    `;

    // Full-screen SVG for Bounding Boxes (Dashed)
    svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgLayer.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; overflow: visible;`;
    
    // TipTour Instruction Tooltip
    tooltipEl = document.createElement('div');
    tooltipEl.style.cssText = `
      position: absolute; top: -100px; left: -100px;
      background: #22c55e; color: white; padding: 6px 12px;
      border-radius: 6px; font-family: system-ui, sans-serif;
      font-size: 14px; font-weight: 500;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      transition: all 0.3s ease; opacity: 0;
      white-space: nowrap; pointer-events: none;
    `;

    shadowRoot.appendChild(svgLayer);
    shadowRoot.appendChild(cursorEl);
    shadowRoot.appendChild(tooltipEl);
    document.body.appendChild(shadowContainer);
    
    requestAnimationFrame(animationLoop);
  }

  function toggleSafetyGlass(lock) {
    if (!safetyGlass) return;
    safetyGlass.style.pointerEvents = lock ? 'all' : 'none';
  }

  let targetX = -100, targetY = -100;
  
  function guideTo(rect, instruction) {
    if (!rect) return;
    currentTarget = rect;
    targetX = rect.left + rect.width / 2;
    targetY = rect.top + rect.height / 2;
    
    // Move cursor
    cursorEl.style.transform = `translate(${targetX}px, ${targetY}px)`;
    
    // Draw TipTour-style dashed green bounding box
    svgLayer.innerHTML = `
      <rect x="${rect.left - 4}" y="${rect.top - 4}" 
            width="${rect.width + 8}" height="${rect.height + 8}" 
            fill="rgba(34, 197, 94, 0.1)" stroke="#22c55e" stroke-width="2" stroke-dasharray="6,4" rx="4" />
    `;

    // Position tooltip
    if (instruction) {
      tooltipEl.textContent = instruction;
      tooltipEl.style.opacity = '1';
      tooltipEl.style.transform = `translate(${rect.left}px, ${rect.top + rect.height + 12}px)`;
    } else {
      tooltipEl.style.opacity = '0';
    }
  }

  function clearOverlay() {
    currentTarget = null;
    svgLayer.innerHTML = '';
    cursorEl.style.transform = `translate(-100px, -100px)`;
    if (tooltipEl) tooltipEl.style.opacity = '0';
    toggleSafetyGlass(false);
  }

  // Idempotent Reconciliation: keeping it glued on scroll
  function animationLoop() {
    if (currentTarget) {
      // In a real SPA, we'd re-query the DOM node here to see if it moved (Morph behavior)
      // For now, we assume bounding box is static relative to viewport unless updated
    }
    requestAnimationFrame(animationLoop);
  }

  // Listen for background commands
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'DRAW_OVERLAY') {
      initOverlay();
      toggleSafetyGlass(true);
      guideTo(msg.rect);
      sendResponse({ status: 'ok' });
    } else if (msg.type === 'DRAW_TIPTOUR_OVERLAY') {
      initOverlay();
      toggleSafetyGlass(true);
      
      const rect = {
        left: msg.coordinates.x,
        top: msg.coordinates.y,
        width: msg.coordinates.width,
        height: msg.coordinates.height
      };
      
      guideTo(rect, msg.instruction);
      sendResponse({ status: 'ok' });
    } else if (msg.type === 'CLEAR_OVERLAY') {
      clearOverlay();
      sendResponse({ status: 'ok' });
    }
  });

})();
