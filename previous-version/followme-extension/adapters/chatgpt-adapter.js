/**
 * FolloMe — ChatGPT Adapter (Phase 2)
 * Handles autonomous reporting and clarification for ChatGPT web UI.
 */
class ChatGPTAdapter extends BaseAIAdapter {
  constructor() {
    super('ChatGPT');
  }

  findInputElement() {
    // Finds the main chat input
    const inputs = Array.from(document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]'));
    return inputs.find(el => el.getBoundingClientRect().width > 50) || null;
  }

  findSendButton() {
    // Finds the send/submit button
    const buttons = Array.from(document.querySelectorAll('button[data-testid*="send" i], button[aria-label*="Send" i]'));
    return buttons.find(btn => btn.getBoundingClientRect().width > 0) || null;
  }

  /**
   * TipTour Technique: Downscale screenshot via client-side canvas
   * to keep payloads small (under 50KB) before attaching to ChatGPT.
   */
  async downscaleImage(base64Str, maxWidth = 800, quality = 0.6) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = base64Str;
    });
  }

  /**
   * Phase 2: Autonomous Clarification Mechanism
   * Returns to the chat, types the issue, attaches screenshot, and hits send.
   */
  async askForClarification(message, screenshotBase64) {
    console.log("[FolloMe:ChatGPT] Autonomously asking for clarification...");
    
    const textInput = this.findInputElement();
    const fileInput = document.querySelector('input[type="file"]');
    
    if (!textInput) {
      console.error("[FolloMe:ChatGPT] Could not find text input to ask clarification.");
      return false;
    }

    // 1. Focus and Type
    textInput.focus();
    await this._delay(200);

    if (textInput.tagName === 'TEXTAREA') {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeInputValueSetter.call(textInput, message);
    } else {
      textInput.innerHTML = `<p>${message}</p>`;
    }
    textInput.dispatchEvent(new Event('input', { bubbles: true }));

    // 2. Downscale and Attach Image
    if (screenshotBase64 && fileInput) {
      try {
        const downscaledBase64 = await this.downscaleImage(screenshotBase64);
        const res = await fetch(downscaledBase64);
        const blob = await res.blob();
        const file = new File([blob], "context.jpg", { type: "image/jpeg" });
        
        const dt = new DataTransfer();
        dt.items.add(file);
        
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log("[FolloMe:ChatGPT] Context screenshot attached.");
        
        // Wait for ChatGPT UI to process the image upload
        await this._delay(2000);
      } catch (e) {
        console.error("[FolloMe:ChatGPT] Failed to attach image:", e);
      }
    }

    // Wait for ChatGPT UI to process the image upload and for the Send button to become enabled
    await new Promise((resolve) => {
        let attempts = 0;
        const checkSendBtn = setInterval(() => {
            attempts++;
            const btn = this.findSendButton();
            if (btn && !btn.disabled && !btn.hasAttribute('disabled')) {
                clearInterval(checkSendBtn);
                btn.click();
                console.log("[FolloMe:ChatGPT] Clarification sent automatically after upload.");
                resolve(true);
            } else if (attempts > 30) { // 15 seconds max
                clearInterval(checkSendBtn);
                console.warn("[FolloMe:ChatGPT] Send button not enabled after 15s. Falling back to Enter.");
                textInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                resolve(true);
            }
        }, 500);
    });

    return true;
  }

  /**
   * Reads the latest AI response from the DOM
   * @returns {string}
   */
  extractLatestMessage() {
    const assistantMessages = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"]'));
    if (assistantMessages.length === 0) return '';
    const latestMessage = assistantMessages[assistantMessages.length - 1];
    return latestMessage.innerText.trim();
  }

  readLatestResponse() {
    return this.extractLatestMessage();
  }

  _delay(ms) {
    return new Promise(res => setTimeout(res, ms));
  }
}

if (typeof window !== 'undefined') {
  window.ChatGPTAdapter = ChatGPTAdapter;
}
