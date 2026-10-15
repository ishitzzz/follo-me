/**
 * FolloMe — AI Content Script
 * Runs on AI platform pages (ChatGPT, Gemini, Claude).
 * Handles prompt injection and response extraction via adapters.
 * Listener is registered immediately and unconditionally.
 */

(() => {
  const alreadyLoaded = !!window.__follomeAIContentLoaded;
  if (alreadyLoaded) {
    console.log('[FolloMe:ai] Already loaded — skipping init.');
    return;
  }
  window.__follomeAIContentLoaded = true;

  window.addEventListener('error', (e) => {
      try { chrome.runtime.sendMessage({ type: 'CRITICAL_TELEMETRY', source: 'ai-content', error: e.message, stack: e.error ? e.error.stack : '' }); } catch (err) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
      try { chrome.runtime.sendMessage({ type: 'CRITICAL_TELEMETRY', source: 'ai-content', error: e.reason ? e.reason.message : 'Unknown promise rejection', stack: e.reason ? e.reason.stack : '' }); } catch (err) {}
  });

  // Resolve adapter early — needed by the listener
  let adapter = null;
  if (typeof AdapterRouter !== 'undefined') {
    adapter = AdapterRouter.getAdapter();
  }

  // Event Monitor Driven Architecture: MutationObserver
  let isWaitingForResponse = false;
  let initialResponseText = '';
  let isClarifying = false;
  let currentSourceTabId = null;
  let timerId = null;

  const observer = new MutationObserver(() => {
      if (isWaitingForResponse && adapter) {
          if (timerId) clearTimeout(timerId);
          timerId = setTimeout(() => {
              const current = adapter.extractLatestMessage();
              if (current && current !== initialResponseText && !current.includes('Analyzing image')) {
                  const isGenerating = typeof adapter.isGenerating === 'function' ? adapter.isGenerating() : false;
                  
                  if (!isGenerating) {
                      if (isWaitingForResponse) {
                          isWaitingForResponse = false;
                          console.log(`[FolloMe:ai] Response completed (${current.length} chars)`);
                          
                          if (isClarifying) {
                              chrome.runtime.sendMessage({
                                  type: 'CLARIFICATION_ANSWER',
                                  payload: current
                              });
                              isClarifying = false;
                          } else {
                              chrome.runtime.sendMessage({
                                  type: 'TEACHER_RESPONSE',
                                  response: current,
                                  platform: adapter.name,
                                  timestamp: Date.now(),
                                  tabId: currentSourceTabId
                              });
                          }
                      }
                  }
              }
          }, 1000);
      }
  });

  const defaultConfig = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] };
  const adapterConfig = (adapter && typeof adapter.getObserverConfig === 'function') ? adapter.getObserverConfig() : {};
  const config = { ...defaultConfig, ...adapterConfig };
  observer.observe(document.body, config);

  // ALWAYS register listener so injection-retry can reach us
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[FolloMe:ai] Received message: ${message.type}`);

    if (message.type === 'INJECT_PROMPT') {
      if (!adapter) {
        console.error('[FolloMe:ai] No adapter available — cannot inject prompt');
        sendResponse({ status: 'error', error: 'No adapter for this page' });
        return true;
      }
      handleInjectPrompt(message.prompt, message.sourceTabId, message.image);
      sendResponse({ status: 'injecting' });
    } else if (message.type === 'PING_AI') {
      sendResponse({
        status: 'alive_ai',
        adapter: adapter?.name || 'none'
      });
    } else if (message.type === 'TRIGGER_CLARIFICATION') {
      if (!adapter) {
        sendResponse({ status: 'error', error: 'No adapter for this page' });
        return true;
      }
      handleClarification(message.message, message.screenshot);
      sendResponse({ status: 'clarifying' });
    } else {
      sendResponse({ status: 'unknown_type' });
    }
    return true;
  });



  if (!adapter) {
    console.warn('[FolloMe:ai] No adapter found for this page');
    return;
  }

  console.log(`[FolloMe:ai] AI adapter loaded: ${adapter.name}`);

  async function handleInjectPrompt(prompt, sourceTabId, image) {
    try {
      console.log(`[FolloMe:ai] Injecting prompt into ${adapter.name}...`);

      const input = await waitForInput(adapter);
      if (!input) {
        console.error('[FolloMe:ai] Timeout waiting for input field');
        notifySource(sourceTabId, 'SHOW_ERROR', {
          error: 'Timeout waiting for input field. Make sure the chat is open.'
        });
        return;
      }

      console.log('[FolloMe:ai] Input field found');
      const injected = await adapter.injectPrompt(prompt, image);
      if (!injected) {
        console.error('[FolloMe:ai] Adapter failed to inject prompt');
        notifySource(sourceTabId, 'SHOW_ERROR', { error: 'Could not inject prompt.' });
        return;
      }
      console.log('[FolloMe:ai] Prompt injected');

      const sent = await adapter.triggerSend();
      if (!sent) {
        console.error('[FolloMe:ai] Adapter failed to trigger send');
        notifySource(sourceTabId, 'SHOW_ERROR', { error: 'Could not click send button.' });
        return;
      }
      console.log('[FolloMe:ai] Send button clicked');

      notifySource(sourceTabId, 'SHOW_LOADING', {
        message: `Waiting for ${adapter.name} response...`
      });

      console.log('[FolloMe:ai] Waiting for AI response via port polling...');
      initialResponseText = adapter.extractLatestMessage();
      isWaitingForResponse = true;
      currentSourceTabId = sourceTabId;

    } catch (err) {
      console.error('[FolloMe:ai] Injection error:', err);
      notifySource(sourceTabId, 'SHOW_ERROR', { error: `Error: ${err.message}` });
    }
  }

  async function handleClarification(message, screenshot) {
    try {
      console.log(`[FolloMe:ai] Triggering autonomous clarification via ${adapter.name}...`);
      if (typeof adapter.askForClarification === 'function') {
        const success = await adapter.askForClarification(message, screenshot);
        if (success) {
          console.log('[FolloMe:ai] Clarification successfully sent.');
          initialResponseText = adapter.extractLatestMessage();
          isClarifying = true;
          isWaitingForResponse = true;
        } else {
          console.error('[FolloMe:ai] Adapter failed to ask for clarification.');
        }
      } else {
        console.warn(`[FolloMe:ai] ${adapter.name} does not support autonomous clarification yet.`);
      }
    } catch (err) {
      console.error('[FolloMe:ai] Clarification error:', err);
    }
  }

  async function waitForInput(adapterInstance, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const input = adapterInstance.findInputElement();
      if (input) return input;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  function notifySource(tabId, type, data = {}) {
    if (!tabId) {
      console.warn('[FolloMe:ai] notifySource — no tabId, cannot relay');
      return;
    }
    chrome.runtime.sendMessage({
      type: 'RELAY_TO_TAB',
      targetTabId: tabId,
      message: { type, ...data }
    });
  }
})();
