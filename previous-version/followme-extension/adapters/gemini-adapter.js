/**
 * FolloMe — Gemini Adapter (Phase 2)
 * Handles autonomous reporting and clarification for Google Gemini web UI.
 */
class GeminiAdapter extends BaseAIAdapter {
  constructor() {
    super('Gemini');
  }

  findInputElement() {
    return (
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][aria-label*="prompt"]') ||
      document.querySelector('rich-textarea .ql-editor') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  findSendButton() {
    return (
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button.send-button') ||
      document.querySelector('button[mattooltip="Send message"]') ||
      document.querySelector('button[aria-label*="Send"]')
    );
  }

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
   */
  async askForClarification(message, screenshotBase64) {
    console.log("[FolloMe:Gemini] Autonomously asking for clarification...");
    
    const textInput = this.findInputElement();
    const fileInput = document.querySelector('input[type="file"]');
    
    if (!textInput) {
      console.error("[FolloMe:Gemini] Could not find text input to ask clarification.");
      return false;
    }

    textInput.focus();
    await this._delay(200);

    // Gemini uses Quill editor — set content via innerHTML
    textInput.innerHTML = `<p>${message}</p>`;
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    textInput.dispatchEvent(new Event('change', { bubbles: true }));

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
        console.log("[FolloMe:Gemini] Context screenshot attached.");
        
        await this._delay(2000);
      } catch (e) {
        console.error("[FolloMe:Gemini] Failed to attach image:", e);
      }
    }

    await this._delay(500);
    const sendBtn = this.findSendButton();
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      console.log("[FolloMe:Gemini] Clarification sent automatically.");
      return true;
    } else {
      textInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      console.log("[FolloMe:Gemini] Clarification sent via Enter key.");
      return true;
    }
  }

  _delay(ms) {
    return new Promise(res => setTimeout(res, ms));
  }
}

if (typeof window !== 'undefined') {
  window.GeminiAdapter = GeminiAdapter;
}
