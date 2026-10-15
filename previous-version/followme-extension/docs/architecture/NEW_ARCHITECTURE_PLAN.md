# Goal Description

The goal is to implement the **Adaptive Hybrid Architecture** for FolloMe, seamlessly combining DOM-based Lyto-style execution for standard sites with TipTour-style CDP fallback for Canvas apps. 

Crucially, we are adopting **Lyto's Memory System** to guarantee perfectly continuous, cross-tab state. We analyzed Lyto's `background.js` and found that it uses an ingenious Event-Driven Local Storage mechanism rather than keeping state purely in RAM (which gets wiped when service workers sleep). FolloMe will replicate this exact memory architecture.

## The Hybrid Execution Strategy

### 1. Default Mode (Lyto Approach - No Banner)
For 95% of the web, FolloMe extracts the DOM using the deep Pseudo-AXTree parser and executes clicks via a synthetic event chain (`PointerEvent` -> `MouseEvent` -> `click()`), resulting in flawless automation with zero security banners.

### 2. Canvas Mode (TipTour Approach - Dynamic CDP)
When FolloMe detects a pure `<canvas>` element (e.g., Figma), it dynamically attaches `chrome.debugger`, fires a native OS-level coordinate click via `Input.dispatchMouseEvent`, and immediately detaches the debugger to minimize the banner.

## Lyto's Memory System (Adopted)

We are integrating Lyto's memory architecture into FolloMe. Here is exactly how it works:
1. **Event-Driven Snapshots:** FolloMe will listen to `chrome.tabs.onActivated`, `chrome.tabs.onUpdated`, and `chrome.tabs.onRemoved`. Every time the user moves, FolloMe rebuilds a global `contextSnapshot` containing the active tab's URL/Title, the agent's current task/goal, and the state of all other open tabs.
2. **Storage Persistence:** This snapshot is instantly written to `chrome.storage.local`. Because Chrome Service Workers frequently go to sleep to save memory, storing state in `chrome.storage.local` guarantees that when the agent wakes back up to execute the next step, its memory is perfectly intact.
3. **Heartbeat Refresh:** Like Lyto, we will run a heartbeat `setInterval` (e.g., every 30 seconds) to ensure the memory snapshot is never stale.

## Proposed Changes

---

### 1. The Global Session Manager (Lyto-Style Memory)

#### [NEW] [brain/session-manager.js](file:///Users/ishitjain/followme-extension/brain/session-manager.js)
- Build the `SessionManager` class inside the Background Service Worker.
- Implement `chrome.tabs` listeners (`onActivated`, `onUpdated`, `onRemoved`).
- Implement the `refreshContextSnapshot()` function which builds the `folloMeSessionSnapshot` object (containing the active task, active tab context, and recent LLM messages) and persists it to `chrome.storage.local`.
- When the agent receives a new command from the ChatGPT window, it simply reads the snapshot from local storage, acts on the correct tab, and updates the storage.

---

### 2. The Adaptive Extractor

#### [MODIFY] [utils/context-extractor.js](file:///Users/ishitjain/followme-extension/utils/context-extractor.js)
- Port Lyto's `dom-collector` logic to build a heavily pruned, indented text tree for standard websites.
- Add a **Canvas Detector**: If a `<canvas>` element takes up >30% of the screen, flag the page as `requires_cdp`.

---

### 3. The Hybrid Execution Engine

#### [NEW] [brain/hybrid-executor.js](file:///Users/ishitjain/followme-extension/brain/hybrid-executor.js)
- A new controller that decides *how* to click based on the `requires_cdp` flag.
- **If DOM:** Dispatch Lyto-style synthetic events via content scripts.
- **If Canvas:** Call `chrome.debugger.attach`, run the CDP `Input.dispatchMouseEvent` to the exact X/Y coordinates, and then `chrome.debugger.detach`.

---

### 4. Background Chat Integration

#### [MODIFY] [watchers/conversation-watcher.js](file:///Users/ishitjain/followme-extension/watchers/conversation-watcher.js)
- Ensure the watcher running on ChatGPT/Claude uses the `SessionManager` state to write autonomous replies to the LLM when FolloMe completes an action or gets stuck on a different tab.

## User Review Required

> [!IMPORTANT]
> The implementation plan now officially integrates **Lyto's Event-Driven Local Storage Memory Strategy** to guarantee perfect cross-tab continuity.
> 
> Does this Memory Architecture + Adaptive Hybrid Strategy look good? If you approve, I will begin coding the `session-manager.js` and `hybrid-executor.js` immediately!
