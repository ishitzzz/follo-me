/**
 * FolloMe — Advanced rrweb Integration (Phase 2)
 * Debounced Event Buffering to determine when the page has "settled" (Network/DOM Idle).
 * Inspired by Morph Tab's idling mechanics.
 */
(() => {
  console.log("[FolloMe:rrweb] Tracker initialized.");

  let mutationTimeout = null;
  const IDLE_DEBOUNCE_MS = 500;
  
  let isTriagingPopup = false;
  let isPopupActiveOnScreen = false;

  function notifyNetworkIdle() {
    if (isPopupActiveOnScreen || isTriagingPopup) {
       console.log("[FolloMe:rrweb] DOM/Network Idle suppressed because a popup is active or being triaged.");
       return;
    }
    
    console.log("[FolloMe:rrweb] DOM/Network Idle Detected (Debounced).");
    // Since this runs in the rrwebiframe, communicate via postMessage to parent (content.js)
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'FOLLOME_NETWORK_IDLE' }, "*");
    } else if (typeof chrome !== 'undefined' && chrome.runtime) {
      // Fallback if running directly in the tab
      chrome.runtime.sendMessage({ type: 'NETWORK_IDLE' }, () => {
          if (chrome.runtime.lastError) {} // Ignore
      });
    }
  }

  function extractInteractiveElements(container) {
      const candidates = [];
      let currentId = 0;
      
      const isInteractive = (el) => {
          if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SELECT' || el.tagName === 'INPUT') return true;
          if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' || el.getAttribute('role') === 'checkbox') return true;
          if (el.tagName === 'SVG' && (el.classList.contains('close') || el.classList.contains('dismiss'))) return true;
          return false;
      };

      const traverse = (node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
              const style = window.getComputedStyle(node);
              if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
                  return; // Skip hidden
              }
              
              if (isInteractive(node)) {
                  const idStr = currentId.toString();
                  node.setAttribute('data-follo-id', idStr);
                  
                  let text = (node.innerText || node.textContent || '').trim();
                  // Truncate text if it's too long
                  if (text.length > 50) text = text.substring(0, 50) + '...';
                  
                  candidates.push({
                      id: idStr,
                      tag: node.tagName.toLowerCase(),
                      text: text,
                      className: node.className || '',
                      ariaLabel: node.getAttribute('aria-label') || ''
                  });
                  currentId++;
                  // Don't traverse inside buttons to avoid getting SVG paths as separate click targets
                  return;
              }
          }
          
          for (let i = 0; i < node.childNodes.length; i++) {
              traverse(node.childNodes[i]);
          }
      };

      traverse(container);
      return candidates;
  }

  function scanForPopups(nodesToCheck = []) {
      let popupDetected = false;
      
      let isFullScan = false;
      // If no nodes provided, scan the whole body (for initial boot)
      if (nodesToCheck.length === 0 && document.body) {
          nodesToCheck = Array.from(document.body.querySelectorAll('*'));
          isFullScan = true;
      }
      
      for (const node of nodesToCheck) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // SKIP FOLLOME INJECTED UI ELEMENTS
          if ((node.id && node.id.toLowerCase().includes('follo')) || 
              (node.className && typeof node.className === 'string' && node.className.toLowerCase().includes('follo'))) {
              continue;
          }
          try {
            const style = window.getComputedStyle(node);
            if (style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const zIndexRaw = style.zIndex;
              const zIndexVal = zIndexRaw === 'auto' ? 0 : parseInt(zIndexRaw, 10);
              if (!isNaN(zIndexVal) && zIndexVal > 10) {
                const rect = node.getBoundingClientRect();
                const viewportArea = window.innerWidth * window.innerHeight;
                const nodeArea = rect.width * rect.height;
                // If it covers > 10% of the screen
                if (nodeArea > viewportArea * 0.1) {
                  popupDetected = true;
                  isPopupActiveOnScreen = true;
                  
                  if (!isTriagingPopup) {
                      isTriagingPopup = true;
                      console.log("[FolloMe:rrweb] Large high z-index popup detected. Locking triage.");
                      
                      const candidates = extractInteractiveElements(node);
                      
                      if (typeof chrome !== 'undefined' && chrome.runtime) {
                        chrome.runtime.sendMessage({ 
                          type: 'POPUP_DETECTED', 
                          candidates: candidates 
                        });
                      }
                  }
                  break; // Only detect one popup per batch
                }
              }
            }
          } catch (e) {}
        }
      }
      
      // ONLY reset if we did a full scan and found nothing
      if (!popupDetected && isFullScan) {
          isPopupActiveOnScreen = false;
      }
      
      return popupDetected;
  }

  // Morph-style debouncing: reset the 500ms timer on ANY mutation
  const observer = new MutationObserver((mutations) => {
    const isOnlyFolloMe = mutations.every(m => 
      (m.target && m.target.id && m.target.id.includes('follome')) ||
      (m.target && m.target.className && typeof m.target.className === 'string' && m.target.className.includes('follo'))
    );
    if (isOnlyFolloMe) return;

    let nodesToCheck = [];
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        nodesToCheck.push(...Array.from(m.addedNodes));
      } else if (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class' || m.attributeName === 'hidden')) {
        nodesToCheck.push(m.target);
      }
    }

    const popupDetected = scanForPopups(nodesToCheck);

    if (mutationTimeout) {
      clearTimeout(mutationTimeout);
    }
    
    // Attempt network idle if no popup is detected (and not currently triaging)
    if (!popupDetected && !isTriagingPopup && !isPopupActiveOnScreen) {
      mutationTimeout = setTimeout(() => {
        notifyNetworkIdle();
      }, IDLE_DEBOUNCE_MS);
    }
  });

  let preClickSnapshot = { url: '', nodeCount: 0 };

  // Listen for deadlock-breaking and diffing messages from the Background Orchestrator
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      
      if (message.type === 'POPUP_TRIAGE_COMPLETE') {
          console.log("[FolloMe:rrweb] Popup triage click executed. Unlocking scanner.");
          isTriagingPopup = false;
          // Re-scan immediately to see if the click actually worked (popup removed)
          setTimeout(() => {
             scanForPopups();
          }, 300);
      }

      if (message.type === 'POPUP_IGNORE_COOLDOWN') {
          console.log("[FolloMe:rrweb] Popup triage failed too many times. Triggering POPUP_UNRESOLVABLE.");
          isTriagingPopup = false; 
          
          if (typeof chrome !== 'undefined' && chrome.runtime) {
            chrome.runtime.sendMessage({ type: 'POPUP_UNRESOLVABLE' });
          }
      }

      // Legacy handler (just in case)
      if (message.type === 'FORCE_RESUME_IDLE_TIMER') {
        console.log("[FolloMe:rrweb] Resuming idle timer after popup failure.");
        isTriagingPopup = false;
        if (mutationTimeout) clearTimeout(mutationTimeout);
        mutationTimeout = setTimeout(() => {
          notifyNetworkIdle();
        }, IDLE_DEBOUNCE_MS);
      }

      if (message.type === 'PRE_CLICK_SNAPSHOT') {
        preClickSnapshot.url = window.location.href;
        preClickSnapshot.nodeCount = document.querySelectorAll('*').length;
        console.log(`[FolloMe:rrweb] Pre-click Snapshot taken. URL: ${preClickSnapshot.url}, Nodes: ${preClickSnapshot.nodeCount}`);
        sendResponse({ status: 'SUCCESS' });
      }

      if (message.type === 'POST_CLICK_DIFF') {
        const currentUrl = window.location.href;
        const currentNodeCount = document.querySelectorAll('*').length;
        console.log(`[FolloMe:rrweb] Post-click Diff. URL: ${currentUrl}, Nodes: ${currentNodeCount}`);
        
        let status = 'SUCCESS';
        // If URL is identical and node count is identical, it's a DUD
        if (currentUrl === preClickSnapshot.url && currentNodeCount === preClickSnapshot.nodeCount) {
            status = 'DUD';
        }
        sendResponse({ status: status });
      }
      return true; // Keep channel open for async sendResponse
    });
  }

  const observeConfig = { childList: true, subtree: true, attributes: true, characterData: true };

  if (document.body) {
    observer.observe(document.body, observeConfig);
    scanForPopups();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, observeConfig);
      scanForPopups();
    });
  }

  // Also listen for network requests (fetch/XHR) by monkeypatching (simplified for Phase 2)
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    if (mutationTimeout) clearTimeout(mutationTimeout);
    try {
      const response = await originalFetch(...args);
      return response;
    } finally {
      if (!isTriagingPopup && !isPopupActiveOnScreen) {
        mutationTimeout = setTimeout(notifyNetworkIdle, IDLE_DEBOUNCE_MS);
      }
    }
  };

})();
