/**
 * FolloMe — Conversational Eavesdropper & Watcher (Phase 2)
 * Acts as the invisible bridge between the user and the ChatGPT/Gemini LLM.
 */
(() => {
  if (window.__follomeWatcherV2Loaded) return;
  window.__follomeWatcherV2Loaded = true;

  console.log('[FolloMe:Watcher] Phase 2 Watcher Initialized');

  // 1. Trigger Interception
  // Listens for Enter key. Intercepts before it goes to the LLM if #followme is present.
  document.addEventListener('keydown', (e) => {
    // ChatGPT uses ProseMirror where e.target might be a <p> inside the contenteditable
    let target = e.target.closest ? (e.target.closest('textarea, [role="textbox"], [contenteditable="true"]') || e.target) : e.target;
    
    // Only care about text inputs/contenteditables
    if (!target.matches('textarea, [role="textbox"], [contenteditable="true"]')) return;

    let val = '';
    if (target.tagName === 'TEXTAREA') val = target.value;
    else val = target.innerText;

    const isTab = (e.key === 'Tab');
    const isEnter = (e.key === 'Enter' && !e.shiftKey);

    // Manual empty input hotkey ( / + Tab )
    if (val.trim() === '/' && isTab) {
      console.log('[FolloMe:Watcher] Tab Trigger intercepted! Arming extension locally.');
      
      e.preventDefault();
      e.stopPropagation();

      if (target.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(target, '');
      } else {
        target.innerHTML = '';
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));

      armExtension();
    }
    
    // Explicit prompt submission (#followme + Enter)
    if (isEnter && /#followme/i.test(val)) {
      if (window._follomeIsProcessing) {
          e.preventDefault();
          e.stopPropagation();
          return;
      }
      window._follomeIsProcessing = true;
      console.log('[FolloMe:Watcher] #followme Trigger intercepted on Submit!');
      
      // Stop ChatGPT from sending the message
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Extract the exact prompt without #followme
      const userPrompt = val.replace(/#followme/gi, '').trim();

      // Highlight the box to show FolloMe is listening
      target.classList.add('follome-active');
      target.style.boxShadow = '0 0 12px 4px rgba(74, 222, 128, 0.6)';
      target.style.transition = 'box-shadow 0.3s ease';
      
      // Clear the box safely
      // Since we prevented submit, we don't have to worry as much about cursor jumping mid-type,
      // but to be safe we just clear the textcontent.
      if (target.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(target, '');
      } else {
        target.innerHTML = '<p><br></p>'; // Standard ProseMirror empty state
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));

      // Remove highlight after 2.5s
      setTimeout(() => {
        target.style.boxShadow = '';
        target.classList.remove('follome-active');
        window._follomeIsProcessing = false;
      }, 2500);

      // Arm and send the explicit prompt
      armExtension(userPrompt);
    }

  }, true); // Use capture phase to intercept early

  function armExtension(userPrompt = '') {
    try {
      chrome.runtime.sendMessage({ type: 'ARM_EXTENSION' });
    } catch (e) {
      console.error('[FolloMe:Watcher] Failed to send ARM_EXTENSION message:', e);
    }
    
    try {
      extractContext(userPrompt);
    } catch (e) {
      console.error('[FolloMe:Watcher] Failed to extract context:', e);
    }
  }

  // 2. Dual-Step Context Gathering
  function extractContext(userPrompt) {
    console.log('[FolloMe:Watcher] Executing Dual-Step Context Gathering...');
    
    // Using Morph's Self-Healing Anchors strategy: 
    // We grab the unstructured text of the main conversation area rather than brittle CSS selectors.
    const mainArea = document.querySelector('main') || document.body;
    let rawText = mainArea.innerText;

    // Append the user's explicit prompt that we intercepted
    if (userPrompt && userPrompt.length > 0) {
      rawText += `\n\nUser Explicit Instruction:\n${userPrompt}`;
      console.log('[FolloMe:Watcher] Appended user prompt:', userPrompt);
    }

    // Send the extracted text and explicit prompt directly to the Multi-Agent Pipeline
    try {
      chrome.runtime.sendMessage({
        type: 'START_AGENT_PIPELINE',
        payload: rawText
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[FolloMe:Watcher] Multi-Agent Pipeline failed to initiate:', chrome.runtime.lastError);
        } else {
          console.log('[FolloMe:Watcher] Multi-Agent Pipeline initiated successfully:', response);
        }
      });
    } catch (e) {
      console.error('[FolloMe:Watcher] Exception initiating pipeline:', e);
    }
  }

})();
