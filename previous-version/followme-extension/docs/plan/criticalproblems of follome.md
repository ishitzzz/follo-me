### **FolloMe Architecture & Execution: Critical Failure Diagnostic**

**Problem 1: SPA Navigation & Multiple Script Injection Crash**

-   **Source:** Console Logs (`Uncaught SyntaxError: Identifier 'ContextExtractor' has already been declared`, etc.)
    
-   **Detailed Description:** When navigating within a Single Page Application (SPA) like Figma, the URL changes dynamically, but the browser does not perform a hard reload. The extension detects these URL changes (via `tabs.onUpdated` or `DOM_SIGNIFICANT_CHANGE`) and mistakenly assumes the user has navigated to a completely new webpage. It aggressively re-injects the core content scripts (`content.js`, `overlay.js`) into the DOM. Because the previous JavaScript execution context is still alive, this causes mass variable redeclaration collisions, instantly paralyzing the local extension environment.
    
-   **Possible Root Cause:** Lack of a global execution guard or state-checking mechanism in the content scripts before initialization. The service worker is blinding pushing scripts on every history state push.
    

**Problem 2: Screenshot API Quota Violation (The Capture Crash)**

-   **Source:** Console Logs (`Error: DevTools security error: This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.`)
    
-   **Detailed Description:** The visual pipeline relies heavily on capturing the screen to feed UI-TARS. When a step fails or an anomaly is detected, the pipeline rapidly attempts to capture the screen again to recover. This creates an unthrottled, recursive loop of screenshot requests that fires multiple times per second. Chrome's API enforces a strict rate limit (~2 captures per second). Exceeding this triggers a fatal rejection that crashes the `runVisualPipeline` async function completely.
    
-   **Possible Root Cause:** Absence of a debounce, throttle, or queueing system on the `chrome.tabs.captureVisibleTab` API call, coupled with the lack of error-handling (`try/catch`) to gracefully back off when the limit is hit.
    

**Problem 3: Background Tab Throttling (The "Tab-Switch" Freeze)**

-   **Source:** Video & User Observation ("Does not analyze the page only until I switch tabs and come back")
    
-   **Detailed Description:** The architecture uses a background ChatGPT tab as the LLM engine. When the user is looking at Figma, the ChatGPT tab is technically "inactive" or in the background. Modern browsers (Chrome) aggressively throttle CPU, memory, and JavaScript execution in background tabs. DOM events like `MutationObserver` (which the extension uses to read ChatGPT's text stream) are heavily delayed or paused entirely until the tab regains focus. Thus, the pipeline freezes in an "Analyzing" state because the background script is physically blocked from reading the AI's response.
    
-   **Possible Root Cause:** Reliance on DOM observation inside an unfocused browser tab. Chrome's resource management policies are suspending the `ai-content.js` event loop.
    

**Problem 4: The UI-TARS Token Death Spiral**

-   **Source:** Telemetry & User Observation (27 requests, 29,000 tokens burned for 0 completed steps).
    
-   **Detailed Description:** The system is spamming the OpenRouter/UI-TARS endpoint without achieving state progression. When the execution engine fails to find a target, or falsely assumes the user is stuck, it fires the exact same target description back to the vision model over and over in rapid succession. This results in massive token consumption while the UI remains locked in a failure loop, providing zero utility to the user.
    
-   **Possible Root Cause:** Missing circuit-breakers in the `executeGuidancePipeline`. If UI-TARS returns null or the user is deemed stuck, the system immediately retries the vision call without introducing a delay, requiring a manual override, or changing the prompt.
    

**Problem 5: False Anomaly Loop ("Screen is Unchanged")**

-   **Source:** Console Logs (`Screen is unchanged. User may be stuck.`) & Video (40-second execution delays).
    
-   **Detailed Description:** The pipeline employs a perceptual hashing or pixel-diffing mechanism to verify if an action (like a click) actually occurred. In complex design tools like Figma, pressing a shortcut key or clicking a tool icon changes an imperceptible number of pixels. The script compares the before-and-after screenshots, detects a sub-threshold pixel change, and falsely concludes the step failed. This triggers an automated anomaly sequence, interrupting the user.
    
-   **Possible Root Cause:** Utilizing rigid visual diffing as the primary source of truth for step progression, which is mathematically incompatible with micro-interactions in dense web applications.
    

**Problem 6: The Cache-Flushing / 8-Step Drop**

-   **Source:** Video & User Observation ("ChatGPT has given a list of eight steps... it just takes one step.")
    
-   **Detailed Description:** When ChatGPT correctly generates a comprehensive, multi-step JSON array (e.g., 8 steps), the extension extracts and caches it. However, because of Problem 5 (False Anomalies), the pipeline almost immediately believes a failure has occurred on Step 1. In its panic state, the system purges the remaining 7 perfectly valid steps from `sessionStorage` and demands a brand new assessment from the AI.
    
-   **Possible Root Cause:** Highly volatile cache invalidation logic. The system does not trust its pre-fetched data and clears the entire queue upon the slightest localized visual discrepancy.
    

**Problem 7: The Single-Step Recovery Trap**

-   **Source:** Video & System Behavior.
    
-   **Detailed Description:** Flowing directly from Problem 6, once the cache is flushed, the system sends an error prompt back to ChatGPT ("SYSTEM ALERT: Screen is unchanged..."). Because the AI is prompted contextually to fix an _error_, it outputs a single, hyper-specific recovery JSON step rather than regenerating the full workflow. The extension executes this one step, verifies it, and then realizes its queue is empty—forcing _another_ full LLM call for the next phase. This destroys pacing and introduces 40-second latencies between single clicks.
    
-   **Possible Root Cause:** Architecture inextricably links error recovery with primary task generation, destroying the sequential step queue whenever a minor hiccup occurs.
    

**Problem 8: Pointer Blocking (Click-Through Geometry Failure)**

-   **Source:** Video & User Observation ("Cursor is right below my actual cursor, so I cannot actually click").
    
-   **Detailed Description:** The custom FolloMe cursor injects an SVG/HTML element exactly at the `(x, y)` target coordinates. Because this injected element sits visually on top of the native Figma UI elements (with a high `z-index`), the browser's hit-testing engine registers the user's hardware mouse clicks on the FolloMe cursor, not the Figma button beneath it. The extension physically shields the target from being interacted with.
    
-   **Possible Root Cause:** Missing CSS `pointer-events: none` on the cursor element, and a lack of coordinate offsetting (e.g., drawing the cursor 15px adjacent to the actual target center).
    

**Problem 9: Viewport Clipping (Tooltip Overflow)**

-   **Source:** Video & User Observation ("Going out of the viewport").
    
-   **Detailed Description:** The instructional tooltip is positioned using absolute CSS based directly on the UI-TARS coordinate output. When a target element is located near the far right or bottom edges of the browser window, the tooltip renders outside the visible bounds of the screen. The user cannot read the instructions or click the "Next" button.
    
-   **Possible Root Cause:** Naive DOM positioning math. The rendering logic does not calculate the tooltip's bounding box (`width`/`height`) against `window.innerWidth` and `window.innerHeight` to detect collisions and dynamically flip the tooltip's orientation.
    

**Problem 10: JSON Parsing Fragility (Array Truncation)**

-   **Source:** Console Logs (`Normalizer output array: Array(1)` for a multi-step string).
    
-   **Detailed Description:** The LLM's text stream is non-deterministic. It frequently wraps the JSON array in Markdown code blocks (`json ...` ) or prepends conversational filler. The local JavaScript normalizer fails to parse this dirty string accurately. In its fallback mode, it attempts to salvage the data by breaking it down line-by-line, which often results in truncating a valid 8-step array into a 1-step array, prematurely ending the workflow.
    
-   **Possible Root Cause:** Inadequate string extraction regex/logic prior to executing `JSON.parse()`.
    

**Problem 11: Obstructive Extension UI Panels**

-   **Source:** Video (The persistent black FolloMe diagnostic panel overlapping Figma's native right sidebar).
    
-   **Detailed Description:** The extension features a persistent, floating diagnostic/status panel (e.g., showing "ANALYZING PAGE VISUALLY"). In dense applications like Figma, this panel physically obscures critical native UI elements (like the Properties sidebar). The AI vision model even gets confused by this, generating steps that tell the user to "close the FolloMe panel" because it recognizes the panel is in the way of the task.
    
-   **Possible Root Cause:** Lack of UI collapsing, minimized states, or intelligent placement for the extension's own diagnostic widgets.
    

**Problem 12: Target Coordinate Drift / Jitter**

-   **Source:** Video ("Finding the exact spot...", "Looking for the right button...").
    
-   **Detailed Description:** When the visual pipeline loops, UI-TARS evaluates the same target multiple times. Because the model processes the image fresh each time, the returned `(x, y)` coordinates for the exact same button often drift by a few pixels. This causes the FolloMe cursor to jitter or jump around the screen while targeting the same object, creating a glitchy, unstable visual experience.
    
-   **Possible Root Cause:** Lack of coordinate smoothing, caching, or tolerance thresholds for targets that have already been acquired in the current execution step.
    

**Problem 13: Unhandled Message Channel Closures**

-   **Source:** Console Logs (`A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received`).
    
-   **Detailed Description:** The `service-worker.js` communicates extensively with content scripts across multiple tabs (ChatGPT tab, Target tab). During high-latency operations (like waiting 40 seconds for an LLM response or a screenshot), the Chrome messaging port times out and closes. When the async function finally resolves and attempts to `sendResponse`, the channel is dead, causing the promise to hang and potentially orphaned state data.
    
-   **Possible Root Cause:** Architectural reliance on long-lived `chrome.runtime.sendMessage` callbacks for multi-second async operations instead of a decoupled, port-based or event-driven messaging architecture. 

**Problem 14: Action Modality Mismatch (Drag vs. Click)**

-   **Source:** Video (Instruction: "Click and drag to draw a frame/rectangle").
    
-   **Detailed Description:** The LLM correctly identifies that creating a shape in Figma requires a "click and drag" motion. However, FolloMe’s execution pipeline and UI-TARS are strictly programmed for binary, point-and-click `(x, y)` coordinate mapping. The extension points the custom cursor to a static single pixel on the canvas, leaving the user confused because drawing requires a bounding-box interaction. The system possesses no UI mechanism (like an animated drag-line) to guide, nor the event listeners to verify, continuous pointer events.
    
-   **Possible Root Cause:** The visual pipeline assumes all web interactions are finite clicks or keyboard inputs, entirely lacking handling for click-and-drag, swipe, or continuous scroll modalities.
    

**Problem 15: Heavy DOM Serialization Overhead (`GET_DOM_SNAPSHOT`)**

-   **Source:** Console Logs (Repeated `type=GET_DOM_SNAPSHOT` calls).
    
-   **Detailed Description:** Prior to visual steps, the Service Worker constantly requests a DOM snapshot from the target tab. Figma has an incredibly deep, complex, and heavy DOM. Serializing this massive node tree into a string/object and passing it across the Chrome messaging channel blocks the main thread and introduces severe computational latency (multiple seconds per call), compounding the overall 40-second delay.
    
-   **Possible Root Cause:** Over-reliance on heavy DOM state inspection in a pipeline that is supposed to be "vision-first." Sending massive payloads over `postMessage` instead of utilizing lightweight, targeted element queries.
    

**Problem 16: Browser Chrome Targeting Failure (Out-of-Bounds Commands)**

-   **Source:** Video (Instruction: "Return to Figma design workspace by clicking the tab above").
    
-   **Detailed Description:** ChatGPT occasionally instructs the user to interact with the browser's own UI (e.g., clicking a Chrome tab, hitting the back button). UI-TARS receives this target and guesses a coordinate near the top edge (`y: 134`) of the viewport. However, the FolloMe cursor is physically constrained to the `document.body`. It cannot overlay instructions or verify clicks outside the web page viewport, leaving the cursor stuck at the top edge of the screen while the user is told to click a browser tab.
    
-   **Possible Root Cause:** The LLM's system prompt lacks strict boundary constraints, failing to force the AI to limit its guidance strictly to elements within the active webpage's DOM.
    

**Problem 17: Normalizer Network Fallback Latency (Groq API)**

-   **Source:** Console Logs (`Attempting native JSON extraction... Falling back to StepNormalizer.normalizeViaGroq...`).
    
-   **Detailed Description:** When the local regex parser fails to cleanly extract the JSON array from ChatGPT's raw text (due to markdown, conversational filler, or missing brackets), it aborts local parsing and fires a network request to an external LLM (Groq) just to format the string. This adds a completely unnecessary external API round-trip, adding seconds of latency to fix data formatting that should be handled locally.
    
-   **Possible Root Cause:** Brittle native string parsing failing on minor edge cases (like trailing commas or unescaped characters), forcing a high-latency network fallback instead of using a resilient local Abstract Syntax Tree (AST) parser.
    

**Problem 18: Async Race Conditions (Concurrency Collisions)**

-   **Source:** Console Logs (Overlapping `Screen is unchanged` errors while `WAITING FOR CHATGPT RESPONSE` is actively logged).
    
-   **Detailed Description:** The pipeline's anomaly detector (the timeout or "unchanged" observer) does not respect the active network state. It fires and logs "stuck" errors _while_ the system is already asynchronously waiting for ChatGPT or UI-TARS to respond. This triggers parallel, colliding execution pipelines that overwrite each other's cache, spam the Chrome messaging ports, and exhaust the screenshot API quotas simultaneously.
    
-   **Possible Root Cause:** The absence of a rigid, global state machine (e.g., locking state flags like `isProcessingVision` or `isWaitingForAI`). Timers and observers are not paused or cleared when asynchronous network calls are initiated. 

**Problem 19: Overlay Contamination in Vision Payload**

-   **Source:** User Observation & Video (LLM instructing the user to "Press Next" or "Close tutorial").
    
-   **Detailed Description:** The `chrome.tabs.captureVisibleTab` API captures a literal snapshot of the active viewport. Currently, it captures the screen _while_ the FolloMe animated cursor and instructional tooltips are rendered. When UI-TARS or ChatGPT analyzes this image, it cannot distinguish between native Figma elements and the extension's injected DOM. The AI hallucinates that the FolloMe tooltip is a native popup and generates erroneous JSON steps instructing the user to interact with FolloMe's own UI (e.g., clicking "Next").
    
-   **Possible Root Cause:** Missing visual toggle logic in the screenshot protocol. The system fails to temporarily hide (`display: none` or `opacity: 0`) the extension's shadow DOM/overlay elements immediately before taking the screenshot, and restoring them immediately after.