/**
 * FolloMe — Main Content Script
 */
(() => {
  const alreadyLoaded = !!window.__follomeContentLoaded;
  if (alreadyLoaded) return;
  window.__follomeContentLoaded = true;

  // Active Tab Driven Polling: Keep SW alive and drive AI polling
  let activePort = chrome.runtime.connect({ name: 'follome-active-port' });
  setInterval(() => {
      try {
          activePort.postMessage({ type: 'HEARTBEAT' });
      } catch (e) {
          // Port disconnected, reconnect
          activePort = chrome.runtime.connect({ name: 'follome-active-port' });
      }
  }, 500);

  window.addEventListener('error', (e) => {
      try { chrome.runtime.sendMessage({ type: 'CRITICAL_TELEMETRY', source: 'content', error: e.message, stack: e.error ? e.error.stack : '' }); } catch (err) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
      try { chrome.runtime.sendMessage({ type: 'CRITICAL_TELEMETRY', source: 'content', error: e.reason ? e.reason.message : 'Unknown promise rejection', stack: e.reason ? e.reason.stack : '' }); } catch (err) {}
  });

  window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'FOLLOME_NETWORK_IDLE') {
          try { 
              chrome.runtime.sendMessage({ type: 'NETWORK_IDLE' }, () => {
                  if (chrome.runtime.lastError) {} // Ignore
              }); 
          } catch (err) {}
      }
  });

  function extractAndSendDOM() {
      console.log("[FolloMe] Extracting DOM Context...");
      if (typeof ContextExtractor === 'undefined') {
          console.error("[FolloMe] ContextExtractor not found");
          return;
      }
      const uiElements = ContextExtractor.getUIElements();
      const domTree = uiElements.map((el, i) => {
          const folloId = `f-${i}`;
          if (el._el) el._el.setAttribute('data-follo-id', folloId);
          return { "data-follo-id": folloId, type: el.type, text: el.text || el.placeholder || el.ariaLabel || el.label || el.title || '' };
      });
      const requires_cdp = (typeof ContextExtractor.detectCanvasHeavy === 'function') ? ContextExtractor.detectCanvasHeavy() : false;
      
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const hasCrossOriginIframes = iframes.some(iframe => {
          try { return !iframe.contentWindow.location.href; } 
          catch (e) { return true; }
      });
      
      chrome.runtime.sendMessage({
          type: 'DOM_EXTRACTED',
          domTree: domTree,
          requires_cdp: requires_cdp,
          hasCrossOriginIframes: hasCrossOriginIframes
      });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_GUIDANCE') {
      if (typeof FolloOverlay !== 'undefined' && message.explanation) {
        FolloOverlay.showResponse(message.explanation);
      }
      if (message.steps) {
        ProgressTracker.init(message.steps);
      }
      sendResponse({ status: 'executing' });

    } else if (message.type === 'SHOW_RESPONSE') {
      if (typeof FolloOverlay !== 'undefined') FolloOverlay.showResponse(message.response);
      sendResponse({ status: 'shown' });
    } else if (message.type === 'SHOW_ERROR') {
      if (typeof FolloOverlay !== 'undefined') FolloOverlay.showError(message.error);
      sendResponse({ status: 'shown' });
    } else if (message.type === 'SHOW_LOADING') {
      if (typeof FolloOverlay !== 'undefined') FolloOverlay.showLoading(message.message || 'Processing...');
      sendResponse({ status: 'shown' });

    } else if (message.type === 'START_DOM_EXTRACTION') {
      extractAndSendDOM();
      sendResponse({ status: 'extracting' });

    } else if (message.type === 'REQUEST_DOM_SNAPSHOT') {
      if (typeof ContextExtractor === 'undefined') {
          sendResponse({ snapshot: null, error: 'ContextExtractor not found' });
      } else {
          const uiElements = ContextExtractor.getUIElements();
          const domTree = uiElements.map((el, i) => {
              const folloId = `f-${i}`;
              if (el._el) el._el.setAttribute('data-follo-id', folloId);
              return { "data-follo-id": folloId, type: el.type, text: el.text || el.placeholder || el.ariaLabel || el.label || el.title || '' };
          });
          
          const iframes = Array.from(document.querySelectorAll('iframe'));
          const hasCrossOriginIframes = iframes.some(iframe => {
              try { return !iframe.contentWindow.location.href; } 
              catch (e) { return true; }
          });
          
          sendResponse({ snapshot: domTree, hasCrossOriginIframes: hasCrossOriginIframes });
      }


    } else if (message.type === 'GET_COORDS') {
      const el = document.querySelector(`[data-follo-id="${message.id}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        sendResponse({ x: Math.max(0, rect.left + rect.width / 2), y: Math.max(0, rect.top + rect.height / 2) });
      } else {
        sendResponse({ x: 0, y: 0 });
      }

    } else if (message.type === 'EXECUTE_TOOL') {
      const { action, args } = message;
      console.log(`[FolloMe] Executing tool in DOM: ${action}`, args);
      try {
        let result = "Tool execution successful.";
        let boundingBox = null;
        if (action === 'click_element' && args.id) {
            const el = document.querySelector(`[data-follo-id="${args.id}"]`);
            if (el) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    boundingBox = { x: Math.max(0, rect.left + rect.width / 2), y: Math.max(0, rect.top + rect.height / 2) };
                }
                el.click();
                result = `Successfully clicked element with follo-id ${args.id}`;
            } else {
                result = `Failed to find element with follo-id ${args.id}`;
            }
        } else if (action === 'type_text' && args.id && args.text) {
            const el = document.querySelector(`[data-follo-id="${args.id}"]`);
            if (el) {
                el.value = args.text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                result = `Successfully typed text into element with follo-id ${args.id}`;
            } else {
                result = `Failed to find element with follo-id ${args.id}`;
            }
        } else if (action === 'hover_element' && args.id) {
            const el = document.querySelector(`[data-follo-id="${args.id}"]`);
            if (el) {
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
                el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
                result = `Successfully hovered element with follo-id ${args.id}`;
            } else {
                result = `Failed to find element with follo-id ${args.id}`;
            }
        } else if (action === 'scroll') {
            if (args.direction === 'down') {
                window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
                result = "Scrolled down.";
            } else if (args.direction === 'up') {
                window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
                result = "Scrolled up.";
            }
        }
        sendResponse({ result, boundingBox });
      } catch (e) {
          sendResponse({ result: `Error: ${e.message}` });
      }

    } else if (message.type === 'PING') {
      sendResponse({ status: 'alive' });
    }
    return true;
  });

  const ProgressTracker = {
    resolvedSteps: [],
    activeStepIndex: 0,
    activeListener: null,
    activeElement: null,
    activeEventType: null,

    init(steps) {
      if (typeof ContextExtractor !== 'undefined') {
        const elements = ContextExtractor.getUIElements();
        this.resolvedSteps = steps.map(s => {
          let targetElement = null;
          if (s.element && document.body.contains(s.element)) {
            targetElement = s.element;
          } else if (s.elementIdx !== undefined && s.elementIdx !== null) {
            targetElement = ContextExtractor.getElementByIndex(elements, s.elementIdx);
          } else if (s.elementSelector) {
            try { targetElement = document.querySelector(s.elementSelector); } catch (e) {}
          }
          return { ...s, targetElement };
        });
      } else {
        this.resolvedSteps = steps;
      }
      this.activeStepIndex = 0;
      this.renderCurrentStep();
    },

    renderCurrentStep() {
      if (this.activeElement && this.activeListener && this.activeEventType) {
        this.activeElement.removeEventListener(this.activeEventType, this.activeListener);
        this.activeListener = null;
        this.activeElement = null;
        this.activeEventType = null;
      }

      if (this.activeStepIndex >= this.resolvedSteps.length) {
        console.log('[FolloMe] ProgressTracker: All steps completed.');
        if (typeof FolloCursorGuide !== 'undefined' && typeof FolloCursorGuide.clearAll === 'function') {
          FolloCursorGuide.clearAll();
        }
        return;
      }

      const step = this.resolvedSteps[this.activeStepIndex];
      const targetElement = step.targetElement;

      if (!targetElement) {
        console.warn(`[FolloMe] ProgressTracker: No targetElement for step ${this.activeStepIndex}`);
        this.activeStepIndex++;
        this.renderCurrentStep();
        return;
      }

      this.activeElement = targetElement;

      if (typeof FolloCursorGuide !== 'undefined' && typeof FolloCursorGuide.startGuidance === 'function') {
        FolloCursorGuide.startGuidance([step]);
      }

      const tagName = targetElement.tagName;
      const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA';
      this.activeEventType = isInput ? 'blur' : 'click';

      this.activeListener = () => {
        console.log(`[FolloMe] Tracker observed interaction on step ${this.activeStepIndex}`);
        this.activeElement.removeEventListener(this.activeEventType, this.activeListener);
        this.activeListener = null;
        this.activeElement = null;
        this.activeEventType = null;

        chrome.runtime.sendMessage({
          type: 'STEP_OUTCOME',
          stepIndex: this.activeStepIndex,
          outcome: 'completed'
        });

        this.activeStepIndex++;
        this.renderCurrentStep();
      };

      this.activeElement.addEventListener(this.activeEventType, this.activeListener);
    }
  };

  const DOMStabilityMonitor = {
    _score: 0,
    _THRESHOLD: 30,
    _resetTimer: null,
    _trackedElements: new Set(),
  
    trackElements(elements) {
      DOMStabilityMonitor._trackedElements = new Set(elements);
    },
  
    scoreMutations(mutations) {
      let score = 0;
      for (const m of mutations) {
        if (m.type === 'characterData') continue;
        if (m.type === 'attributes' && m.attributeName === 'style') continue;
        if (m.type === 'attributes' && m.attributeName === 'class') {
          if (DOMStabilityMonitor._trackedElements.has(m.target)) { score += 15; continue; }
          continue;
        }
        if (m.type === 'attributes') {
          if (['disabled', 'hidden', 'aria-hidden', 'aria-disabled'].includes(m.attributeName)) {
            if (DOMStabilityMonitor._trackedElements.has(m.target)) { score += 20; continue; }
            score += 2; continue;
          }
          continue;
        }
        if (m.type === 'childList') {
          for (const node of m.removedNodes) {
            if (node.nodeType !== 1) continue;
            if (DOMStabilityMonitor._trackedElements.has(node)) { score += 50; continue; }
            if (node.querySelector && [...DOMStabilityMonitor._trackedElements].some(el => node.contains(el))) {
              score += 50; continue;
            }
          }
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const interactiveCount = (node.matches?.('input,button,select,a,[role="button"]') ? 1 : 0) +
              (node.querySelectorAll?.('input,button,select,a,[role="button"]')?.length || 0);
            if (interactiveCount > 3) { score += 25; continue; }
            if (interactiveCount > 0) { score += 5; continue; }
          }
        }
      }
      return score;
    },
  
    onMutation(mutations) {
      const batchScore = DOMStabilityMonitor.scoreMutations(mutations);
      DOMStabilityMonitor._score += batchScore;
  
      clearTimeout(DOMStabilityMonitor._resetTimer);
      DOMStabilityMonitor._resetTimer = setTimeout(() => {
        if (DOMStabilityMonitor._score >= DOMStabilityMonitor._THRESHOLD) {
          chrome.runtime.sendMessage({
            type: 'DOM_SIGNIFICANT_CHANGE',
            score: DOMStabilityMonitor._score,
            affectsTrackedElements: DOMStabilityMonitor._score >= 50
          });
        }
        DOMStabilityMonitor._score = 0;
      }, 500);
    }
  };
  
  window.DOMStabilityMonitor = DOMStabilityMonitor;
  
  const hostname = window.location.hostname;
  const isAIPlatform = hostname.includes('chatgpt.com') || hostname.includes('claude.ai') || hostname.includes('gemini.google.com');

  if (!isAIPlatform) {
    const observer = new MutationObserver((muts) => DOMStabilityMonitor.onMutation(muts));
    if (document.body) {
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'aria-disabled']
      });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'aria-disabled']
        });
      });
    }
  }



  if (typeof ContextExtractor !== 'undefined') {
    chrome.runtime.sendMessage({
      type: 'PAGE_READY'
    });

    // 1. Inject MultiOn-style Iframes
    function injectIframe(id, src) {
        if (!document.getElementById(id)) {
            const iframe = document.createElement('iframe');
            iframe.id = id;
            iframe.src = chrome.runtime.getURL(src);
            iframe.style.position = 'fixed';
            iframe.style.zIndex = '2147483647';
            iframe.style.border = 'none';
            // Hide the rrweb iframe, show chat assistant
            if (id === 'follo-rrweb-iframe') {
                iframe.style.display = 'none';
            } else {
                iframe.style.display = 'none'; // Hidden by default in Phase 2
                iframe.style.bottom = '20px';
                iframe.style.right = '20px';
                iframe.style.width = '350px';
                iframe.style.height = '500px';
                iframe.style.boxShadow = '0 10px 30px rgba(0,0,0,0.3)';
                iframe.style.borderRadius = '16px';
            }
            document.body.appendChild(iframe);
            console.log(`[FolloMe] Injected iframe: ${id}`);
        }
    }
    
    injectIframe('follo-chat-assistant', 'views/chat_assistant.html');
    injectIframe('follo-rrweb-iframe', 'views/rrwebiframe.html');

    // 2. Perform DOM Extraction and send to Service Worker
    setTimeout(extractAndSendDOM, 1000); // Wait 1s for page to settle
  }
})();
