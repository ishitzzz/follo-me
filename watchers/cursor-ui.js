/**
 * FolloMe — Cursor UI (Phase 2)
 * Injects a TipTour-style minimal input box directly at the cursor coordinates
 * when the user presses Cmd/Ctrl + Shift + K. Uses an iframe for styling isolation.
 */
(() => {
  if (window.__follomeCursorUILoaded) return;
  window.__follomeCursorUILoaded = true;

  let currentMouseX = 0;
  let currentMouseY = 0;
  let uiIframe = null;

  // Track mouse position globally
  document.addEventListener('mousemove', (e) => {
    currentMouseX = e.clientX;
    currentMouseY = e.clientY;
  });

  // Listen for the hotkey
  document.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifier = isMac ? e.metaKey : e.ctrlKey;
    
    if (modifier && e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      spawnCursorUI();
    }
  });

  function spawnCursorUI() {
    if (uiIframe) {
      uiIframe.remove();
      uiIframe = null;
    }

    uiIframe = document.createElement('iframe');
    uiIframe.id = 'follome-cursor-iframe';
    
    // Style as a floating overlay at mouse coordinates
    uiIframe.style.cssText = `
      position: fixed;
      top: ${currentMouseY}px;
      left: ${currentMouseX}px;
      width: 360px;
      height: 120px;
      border: none;
      background: transparent;
      z-index: 2147483647;
      pointer-events: auto;
      transform: translateY(-50%);
    `;

    document.body.appendChild(uiIframe);

    // TipTour style minimalistic input UI
    const doc = uiIframe.contentDocument;
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            margin: 0;
            padding: 10px;
            background: transparent;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            box-sizing: border-box;
          }
          .tiptour-tooltip {
            background: rgba(30, 30, 30, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 16px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
            padding: 20px;
            width: 320px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
          }
          .tiptour-message {
            color: #ddd;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 500;
          }
          .tiptour-input {
            width: 100%;
            box-sizing: border-box;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 10px 14px;
            font-size: 14px;
            outline: none;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: rgba(255, 255, 255, 0.05);
            color: #ddd;
            transition: all 0.2s ease;
          }
          .tiptour-input:focus {
            background: rgba(255, 255, 255, 0.08);
            border-color: #fff;
            color: #fff;
          }
          .tiptour-input::placeholder { color: #666; }
        </style>
      </head>
      <body>
        <div class="tiptour-tooltip">
          <div class="tiptour-message">Ask FolloMe</div>
          <input type="text" class="tiptour-input" id="queryInput" placeholder="What do you want to do?" autocomplete="off">
        </div>
        <script>
          const input = document.getElementById('queryInput');
          input.focus();
          
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.trim()) {
              window.parent.postMessage({ type: 'FOLLOME_QUERY', query: input.value.trim() }, '*');
            } else if (e.key === 'Escape') {
              window.parent.postMessage({ type: 'FOLLOME_CLOSE' }, '*');
            }
          });
        </script>
      </body>
      </html>
    `);
    doc.close();

    // Focus iframe input
    setTimeout(() => {
      if (uiIframe.contentWindow) uiIframe.contentWindow.focus();
    }, 50);
  }

  // Handle messages from the iframe
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;

    if (e.data.type === 'FOLLOME_CLOSE' && uiIframe) {
      uiIframe.remove();
      uiIframe = null;
    }

    if (e.data.type === 'FOLLOME_QUERY' && uiIframe) {
      const query = e.data.query;
      console.log('[FolloMe:CursorUI] Relaying query:', query);
      
      // Tell background to route it to the active LLM
      chrome.runtime.sendMessage({
        type: 'RELAY_QUERY_TO_LLM',
        query: query
      });

      uiIframe.remove();
      uiIframe = null;
    }
  });

})();
