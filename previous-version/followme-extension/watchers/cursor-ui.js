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
      width: 320px;
      height: 60px;
      border: none;
      border-radius: 30px;
      background: transparent;
      z-index: 2147483647;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
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
            padding: 0;
            background: #ffffff;
            border-radius: 30px;
            display: flex;
            align-items: center;
            height: 100vh;
            font-family: system-ui, -apple-system, sans-serif;
            box-sizing: border-box;
            border: 1px solid #e5e7eb;
          }
          input {
            flex-grow: 1;
            border: none;
            outline: none;
            padding: 0 20px;
            font-size: 14px;
            color: #111827;
            background: transparent;
          }
          input::placeholder { color: #9ca3af; }
          .mic-btn {
            background: none;
            border: none;
            padding: 0 20px;
            cursor: pointer;
            color: #6366f1;
            font-size: 16px;
            transition: transform 0.1s;
          }
          .mic-btn:active { transform: scale(0.9); }
        </style>
      </head>
      <body>
        <input type="text" id="queryInput" placeholder="Ask FolloMe..." autocomplete="off">
        <button class="mic-btn" id="micBtn">🎤</button>
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
          
          document.getElementById('micBtn').onclick = () => {
             // Future voice integration
             window.parent.postMessage({ type: 'FOLLOME_VOICE_START' }, '*');
          };
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
