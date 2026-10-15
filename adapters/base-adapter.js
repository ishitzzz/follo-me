/**
 * FolloMe — Base AI Adapter
 * Abstract base class for all AI platform adapters.
 * Each adapter handles finding input, sending prompt, and reading response.
 */

class BaseAIAdapter {
  constructor(name) {
    this.name = name;
    this._lastResponse = '';
  }

  /**
   * Find the input element on the AI page
   * @returns {HTMLElement|null}
   */
  findInputElement() {
    throw new Error(`${this.name}: findInputElement() not implemented`);
  }

  /**
   * Find the send/submit button
   * @returns {HTMLElement|null}
   */
  findSendButton() {
    throw new Error(`${this.name}: findSendButton() not implemented`);
  }

  /**
   * Inject text and optionally an image into the input field
   * @param {string} text
   * @param {string} image base64 image
   */
  async injectPrompt(text, image) {
    const input = this.findInputElement();
    if (!input) {
      console.warn(`[FolloMe][${this.name}] Input element not found`);
      return false;
    }

    // Focus the input
    input.focus();

    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);

    if (image) {
      await this.attachImage(image);
    }

    // Small delay to let UI update
    await this._delay(300);
    return true;
  }

  async attachImage(base64Str) {
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) return false;
    
    try {
      let finalBase64 = base64Str;
      if (typeof this.downscaleImage === 'function') {
        finalBase64 = await this.downscaleImage(base64Str);
      }
      
      const res = await fetch(finalBase64);
      const blob = await res.blob();
      const file = new File([blob], "context.jpg", { type: "image/jpeg" });
      
      const dt = new DataTransfer();
      dt.items.add(file);
      
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`[FolloMe][${this.name}] Context screenshot attached.`);
      
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const btn = this.findSendButton();
        if (btn && !btn.disabled && !btn.hasAttribute('disabled')) {
          break;
        }
        await this._delay(200);
      }
      return true;
    } catch (e) {
      console.error(`[FolloMe][${this.name}] Failed to attach image:`, e);
      return false;
    }
  }

  isGenerating() {
    const stopBtn = document.querySelector('button[aria-label*="Stop generating" i], button[aria-label*="Stop" i], button[mattooltip*="Stop" i]');
    return !!stopBtn;
  }

  /**
   * Click the send button
   */
  async triggerSend() {
    const btn = this.findSendButton();
    if (btn) {
      btn.click();
      return true;
    }

    // Fallback: try Enter key
    const input = this.findInputElement();
    if (input) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true
      }));
      return true;
    }

    return false;
  }

  /**
   * Read the latest AI response from the DOM
   * @returns {string}
   */
  readLatestResponse() {
    throw new Error(`${this.name}: readLatestResponse() not implemented`);
  }

  /**
   * Extract the latest message text
   * @returns {string}
   */
  extractLatestMessage() {
    throw new Error(`${this.name}: extractLatestMessage() not implemented`);
  }

  /**
   * Wait for a new response to appear
   * @param {number} timeout - ms to wait
   * @returns {string|null}
   */
  async waitForResponse(timeout = 30000) {
    const startTime = Date.now();
    const initialResponse = this.readLatestResponse();

    while (Date.now() - startTime < timeout) {
      await this._delay(1000);

      const current = this.readLatestResponse();

      // Check if response has changed and is no longer streaming
      if (current && current !== initialResponse) {
        // Wait a bit more to make sure streaming is done
        await this._delay(2000);
        const final = this.readLatestResponse();

        // If response stabilized, we're done
        if (final === current || final.length >= current.length) {
          this._lastResponse = final;
          return final;
        }
      }
    }

    return null;
  }

  /**
   * Full flow: inject prompt -> send -> wait for response
   */
  async sendAndReceive(prompt) {
    const injected = await this.injectPrompt(prompt);
    if (!injected) return null;

    await this._delay(500);

    const sent = await this.triggerSend();
    if (!sent) return null;

    return await this.waitForResponse();
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

if (typeof window !== 'undefined') {
  window.BaseAIAdapter = BaseAIAdapter;
}
