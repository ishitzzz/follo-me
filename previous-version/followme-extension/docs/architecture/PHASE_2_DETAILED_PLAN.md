# Phase 2 Detailed Plan: The Agentic Automation & UX Layer

## 1. Overview of Phase 1 vs Phase 2
**Phase 1 (Completed): The Foundation**
We successfully built the underlying execution architecture:
- **Global Session Manager (Lyto-style)**: Event-driven memory using `chrome.storage.local`.
- **Adaptive Context Extractor**: Pseudo-Accessibility tree generation with Canvas detection.
- **Hybrid Executor (TipTour-style)**: Routing clicks between DOM synthetic events and CDP (`chrome.debugger`).
- **Offscreen Brain (MultiOn-style)**: Persistent background LLM inference without service worker timeouts.

**Phase 2 (The Next Step): Automation, Chat Integration, & UI**
Phase 2 focuses on connecting this robust backend to the user experience and the ChatGPT/Gemini LLM frontend (with Claude support planned for later). We will implement the Conversational Watcher, the Autonomous Reporter, On-Page Cursor UI, and the Visual Annotations Layer.

---

## 2. Implementations Chosen for Phase 2

### A. The Conversational Eavesdropper & Watcher
* **Objective:** Act as an invisible bridge between the user and ChatGPT/Gemini.
* **Target File:** `watchers/conversation-watcher.js`
* **Features:**
  - **The Trigger Interception:** Listens for the `#followme` keyword with specific symbols or the manual empty input hotkey (`/` then `Tab`) to arm the extension. **Crucially, the watcher intercepts the send event so the `#followme` keyword does NOT get sent to the LLM; it is strictly used to trigger the extension locally.**
  - **Dual-Step Context Gathering:**
    - **Global Summarizer:** Summarizes the whole chat history into a dense 3-4 line paragraph representing the macro context.
    - **Dynamic Bottom-Up Semantic Collection:** Tracks the very last message and reads upwards (bottom-up) to get the context and actionable steps, stopping only when it detects a hard semantic shift.
  - Auto-injects the *"✨ Execute this for me"* button when a UI workflow is detected.
* **Reference Extensions:** 
  - **Morph**: We will use Morph's "Self-Healing Anchors" strategy. Instead of hardcoded CSS selectors (which break when OpenAI updates ChatGPT), we will extract the unstructured DOM of the chat area and use the fast Groq model to structurally map the conversation.

### B. Autonomous Dispatch & The Clarification Mechanism
* **Objective:** Allow FolloMe to report back to ChatGPT/Gemini automatically without user intervention (e.g., if it hits a CAPTCHA or finishes a task).
* **Target File:** `adapters/chatgpt-adapter.js`
* **Features:**
  - **How FolloMe Asks for Clarification:**
    - If the agent gets stuck or needs help (e.g., 'all items are over budget'), it autonomously returns to the ChatGPT/Gemini tab.
    - It simulates natural human typing into the `#prompt-textarea` to ask the LLM for clarification.
    - It automatically attaches a downscaled screenshot of the problematic tab for context.
  - **Autonomous Dispatch:** Programmatically triggers the "Send/Submit" button to continue the loop.
* **Reference Extensions:**
  - **TipTour**: For downscaling the screenshot client-side via an HTML5 `<canvas>` before attaching it, keeping the payload under 50KB.

### C. On-Page Contextual Querying (The Cursor UI)
* **Objective:** Allow users to ask questions or trigger actions directly on the target page without switching tabs back to the chat.
* **Target File:** `watchers/cursor-ui.js`
* **Features:**
  - **TipTour UI Exclusivity:** We will strictly use TipTour's styling for the input text box and all UI features. No heavy frontend frameworks will be used.
  - Injects a hotkey listener (`Cmd/Ctrl + Shift + K`).
  - Spawns a minimal text/mic input exactly at the mouse cursor's `(x, y)` coordinates.
  - Sends the query (and a silent screenshot) to the background worker to relay to ChatGPT/Gemini.
* **Reference Extensions:**
  - **MultiOn**: We will inject this UI via an isolated `iframe` (Web Accessible Resource) to prevent the host website's CSS from breaking our design.
  - **TipTour**: For the minimal text input box styling.

### D. Smart Contextual Annotations & Guardrails
* **Objective:** Provide elegant, native-feeling visual guidance to the user.
* **Target File:** `content/overlay.js` (and styling)
* **Features:**
  - **TipTour Motion & Cursors:** We will inject the exact SVG cursor from TipTour, perfectly mimicking how the cursor moves, its motion physics, and its rendering style.
  - **Shadow DOM / SVG Layer:** Inject a full-screen, invisible SVG overlay to draw dashed boxes and floating labels.
  - **Scroll-Locked Tracking:** Keep annotations glued to target elements using `requestAnimationFrame`.
  - **Screen Locking (Safety Glass):** Intercept stray clicks using `pointer-events: all` while the agent is drawing or explaining.
* **Reference Extensions:**
  - **TipTour**: For the Ghost Cursor SVG, cursor movement logic, and lightweight tooltip design.
  - **Morph**: For SPA Idempotent Reconciliation. Our tooltips must re-assert themselves if a React page re-renders.

### E. Advanced `rrweb` Integration (Incremental State Streaming)
* **Objective:** Stop relying on blind timeouts when waiting for page loads.
* **Target File:** `brain/rrweb-tracker.js`
* **Features:**
  - Use the `rrwebiframe.html` to stream DOM mutations.
  - Only execute the next step when the network/DOM hits an "idle" state.
* **Reference Extensions:**
  - **Morph Tab**: For Debounced Event Buffering. We wait for a 500ms debounce of mutations before deciding the page has settled.

---

## 3. Execution Plan

We will proceed in the following order:
1. **Create the ChatGPT Adapter & Watcher:** Implement the self-healing ChatGPT parser and autonomous dispatcher.
2. **Build the Cursor UI:** Implement the `Cmd+Shift+K` hotkey overlay using a sandboxed iframe.
3. **Develop the Visual Annotation Engine:** Implement the SVG Shadow DOM for rendering tooltips and ghost cursors.
4. **Integrate `rrweb` Tracking:** Wire the debounced mutation tracking to the background brain to govern step-by-step execution pacing.

---

## 4. Roadmap to Phase 3 (The Agentic Autonomy Layer)

To clarify the roadmap, Phase 2 focuses solely on **bridging the communication** between ChatGPT/Gemini and the user's screen. 

The advanced, independent planning and research capabilities you mentioned will be implemented in **Phase 3**.

### What Phase 3 Will Include:
1. **The Grounding Orchestrator (Internal Planning):** After the ChatGPT/Gemini watcher passes the goal to the extension, the "Offscreen Brain" will run its own internal state machine (The Fast Check -> Scroll & Hunt -> Vision Fallback) to figure out *exactly* how to execute the high-level goal on the current DOM.
2. **Autonomous Navigation & Search APIs:** Implementing the integration with Serper.dev or Tavily. Instead of writing heavy scrapers, the agent will use these Search APIs to instantly find the correct official URL and open it for the user automatically.
3. **The Local Ghost Scout:** Creating the hidden background tab (`chrome.tabs.create({ active: false })`). The agent will use this invisible tab to explore ahead, clear disruptive popups, map the exact route, and hand a flawless, zero-latency execution plan to the visible tab for the user.
