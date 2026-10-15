# FolloMe: Phase 1 Detailed Implementation Specification

This document provides the exact, file-by-file technical instructions to build Phase 1 of the FolloMe Agentic Architecture. It explicitly details what code is being adapted from the `lyto-chrome-agent`, `tiptour-extension`, and `multion_unpacked` reference files, and how it translates into the new FolloMe codebase.

## 1. Environment & Config Setup

Since the extension lacks `.env` files (excluded from GitHub), we will build a robust JavaScript-based environment loader.

### [NEW] `followme-extension/.env.example`
**Purpose:** A template showing the required environment variables.
```env
LLAMA_API_KEY=your_api_key_here
LLAMA_PROVIDER_URL=https://api.groq.com/openai/v1/chat/completions # or other Llama-3.1-8b-instant provider
```

### [NEW] `followme-extension/config.js`
**Purpose:** Since we are not using a bundler (like Webpack) that supports `.env` natively in a raw Chrome Extension, we will use a global `config.js` file that must be added to `.gitignore`.
**Implementation Detail:**
```javascript
// config.js (add to .gitignore)
export const config = {
    LLAMA_API_KEY: "insert_key_here",
    LLAMA_PROVIDER_URL: "https://api.groq.com/openai/v1/chat/completions",
    FAST_MODEL: "llama-3.1-8b-instant",
    COMPLEX_MODEL: "llama-3.3-70b-versatile"
};
```

---

## 2. Global Session Manager (The Lyto Memory System)

We will recreate the event-driven storage mechanism found in Lyto to ensure cross-tab continuity.

### [NEW] `followme-extension/brain/session-manager.js`
**Purpose:** To manage `chrome.storage.local` updates dynamically when the user switches tabs, mimicking Lyto's robust session tracking.

**Code to Adapt:**
From `lyto-chrome-agent/2.1.5_0/background.js`, Lyto tracks the active tab and writes to `chrome.storage`. We will implement a `SessionManager` class:
1. **Listeners:** Hook into `chrome.tabs.onActivated`, `chrome.tabs.onUpdated`, and `chrome.tabs.onRemoved`.
2. **Snapshot Logic:** Whenever a tab changes, call `chrome.tabs.get(activeInfo.tabId)`.
3. **Storage Write:** Construct a `contextSnapshot` object containing `url`, `title`, and the `activeAgentTask` (if any). Write this to `chrome.storage.local.set({ folloMeSession: contextSnapshot })`.

### [NEW] `followme-extension/background/background.js` (or modifying the existing one)
**Purpose:** Initialize the `SessionManager` and establish the heartbeat.
**Implementation Detail:**
```javascript
import { SessionManager } from '../brain/session-manager.js';

const sessionManager = new SessionManager();
sessionManager.initializeListeners();

// The Heartbeat (Lyto style): keeps the state fresh
setInterval(() => {
    sessionManager.refreshSnapshot();
}, 30000); // 30 seconds
```

---

## 3. The Adaptive Context Extractor (DOM + Canvas Detection)

We will combine Lyto's DOM pruning with TipTour's canvas detection.

### [MODIFY] `followme-extension/utils/context-extractor.js`
**Purpose:** Extract a minimal, semantic text-tree of the DOM and flag Canvas apps for CDP fallback.

**Code to Adapt:**
1. **Lyto's Pseudo-AXTree Logic:** From `lyto-chrome-agent/2.1.5_0/content.js` (or similar extraction scripts). We will implement a recursive DOM walker that skips `<script>`, `<style>`, and invisible elements (using `window.getComputedStyle`). It will extract `tagName`, `id`, `class`, `aria-label`, and `innerText`, indenting them to represent the DOM hierarchy visually for the LLM.
2. **TipTour's Canvas Detector:** 
   ```javascript
   function detectCanvasDominance() {
       const canvases = document.querySelectorAll('canvas');
       let maxCanvasArea = 0;
       for (const canvas of canvases) {
           const rect = canvas.getBoundingClientRect();
           const area = rect.width * rect.height;
           if (area > maxCanvasArea) maxCanvasArea = area;
       }
       const viewportArea = window.innerWidth * window.innerHeight;
       return (maxCanvasArea / viewportArea) > 0.3; // If canvas is > 30% of screen
   }
   ```
3. **Output:** The script will return `{ domTree: string, requires_cdp: boolean }`.

---

## 4. Hybrid Execution Engine (DOM + TipTour CDP)

This component decides how to click on an element based on the `requires_cdp` flag.

### [NEW] `followme-extension/brain/hybrid-executor.js`
**Purpose:** Route execution to standard content scripts (synthetic clicks) or the background CDP debugger.

**Code to Adapt:**
From `tiptour-extension/cdp-driver.js`: TipTour attaches the debugger to send native OS-level coordinate clicks.
**Implementation Detail:**
```javascript
export async function executeClick(tabId, target, requiresCdp) {
    if (requiresCdp) {
        // TipTour-style CDP Fallback (Canvas Apps)
        return new Promise((resolve) => {
            chrome.debugger.attach({ tabId: tabId }, "1.3", () => {
                const clickEvent = {
                    type: 'mousePressed',
                    x: target.x,
                    y: target.y,
                    button: 'left',
                    clickCount: 1
                };
                chrome.debugger.sendCommand({ tabId: tabId }, "Input.dispatchMouseEvent", clickEvent, () => {
                    clickEvent.type = 'mouseReleased';
                    chrome.debugger.sendCommand({ tabId: tabId }, "Input.dispatchMouseEvent", clickEvent, () => {
                        chrome.debugger.detach({ tabId: tabId }); // Minimize yellow banner
                        resolve(true);
                    });
                });
            });
        });
    } else {
        // Lyto-style Synthetic DOM Click (Standard Web)
        return chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (selector) => {
                const el = document.querySelector(selector);
                if (el) {
                    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    el.click();
                    return true;
                }
                return false;
            },
            args: [target.selector]
        });
    }
}
```

---

## 5. The Offscreen "Little Brain" (MultiOn-Style)

To prevent Service Worker suspension during the `llama-3.1-8b-instant` API call, we use the Offscreen Document pattern found in MultiOn.

### [NEW] `followme-extension/offscreen.html`
**Purpose:** A hidden HTML document to host the persistent script.
```html
<!DOCTYPE html>
<html>
<head>
    <script type="module" src="brain/offscreen.js"></script>
</head>
<body></body>
</html>
```

### [NEW] `followme-extension/brain/offscreen.js`
**Purpose:** The central logic loop that talks to the LLM API. Because this is an offscreen document, Chrome will not terminate it for taking too long.

**Implementation Detail:**
1. Import `config.js` to get `LLAMA_API_KEY` and `FAST_MODEL`.
2. Listen for messages from `background.js` (e.g., `{ action: "EVALUATE_DOM", domTree: "..." }`).
3. Make standard `fetch()` requests to the Llama API endpoint with the strict JSON prompt.
4. Return the parsed JSON execution array back to `background.js` via `chrome.runtime.sendMessage`.

### [MODIFY] `followme-extension/background/background.js`
**Implementation Detail:** Add the MultiOn-style boot sequence:
```javascript
async function setupOffscreenDocument(path) {
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenDocument = existingContexts.find(c => c.contextType === 'OFFSCREEN_DOCUMENT');
    if (!offscreenDocument) {
        await chrome.offscreen.createDocument({
            url: path,
            reasons: ['DOM_PARSER'], // Justification for Chrome
            justification: 'Running background LLM inference and parsing'
        });
    }
}
// Call this on extension startup
setupOffscreenDocument('offscreen.html');
```

---

## 6. Developer Trace UI

### [NEW] `followme-extension/debug.html`
**Purpose:** A UI to visualize the `SessionManager`'s current `chrome.storage.local` snapshot, the extracted `domTree`, and the live JSON output from the Offscreen Brain. This is crucial for verifying that the Agent is "seeing" the right DOM and planning correctly before the actual executor clicks anything.

---

## 7. MultiOn-Style State Tracking & UI Injection (rrweb)

As highlighted in the MultiOn architecture analysis, we will use Web Accessible Resources to inject `rrweb` and our UI safely into the host page, avoiding CSS bleeding and allowing real-time mutation tracking without heavy DOM polling.

### [NEW] `followme-extension/rrwebiframe.html` & `followme-extension/brain/rrweb-tracker.js`
**Purpose:** An isolated iframe injected into the user's active tab to stream DOM mutations back to the Offscreen Brain.
**Implementation Detail:**
1. Add `rrwebiframe.html` to `web_accessible_resources` in `manifest.json`.
2. The background script injects this iframe into the active page.
3. Inside the iframe, `rrweb.record()` listens for DOM mutations (like loading spinners appearing/disappearing).
4. When mutations stop (Network Idle), it fires a message to the Offscreen Brain, letting it know it is safe to execute the next step.

### [NEW] `followme-extension/chat_assistant.html`
**Purpose:** The minimal, sandboxed UI for the FolloMe agent that will be injected as an iframe to prevent host-page CSS conflicts (MultiOn style).
