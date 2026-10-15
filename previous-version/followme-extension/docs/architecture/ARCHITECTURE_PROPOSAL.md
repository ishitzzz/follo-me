# FolloMe - Next Generation Agentic Architecture

## Overview
This document outlines the proposed architectural shift for the **FolloMe** browser extension. The goal is to evolve the system from a rigid, reactive pipeline (which blindly follows high-level LLM instructions) into a **Constrained Agentic Orchestrator**. This new architecture solves critical issues related to LLM hallucinations, UI latency, API costs, and modern web application complexities (e.g., Canvas-based apps).

## The Core Challenges Being Addressed
1. **The Grounding Problem:** High-level planners (like ChatGPT) often hallucinate UI elements or provide vague instructions (e.g., "Click the Contents button" when it's actually hidden in a dropdown).
2. **Latency and Cost:** Running every single user step through a heavy Vision-Language Model (VLM) via screenshot uploads is slow and expensive.
3. **The "Canvas Black Box":** While standard websites use the DOM, modern tools like Figma, Canva, and Google Docs use `<canvas>`, rendering standard DOM-parsing blind.
4. **Agentic Drift:** Unconstrained autonomous agents can get stuck in infinite loops (e.g., endlessly scrolling or taking screenshots if they can't find a button).

---

---

## 1. Initiation & Seamless Navigation (The Chat-First UX)

Instead of requiring the user to manually find the target website and click the extension popup, FolloMe operates entirely inside the AI chat interface (ChatGPT/Claude/Gemini).

1. **The `#follome` Trigger:** The user (or the AI) types a trigger command directly in the chat, for example: *"#follome take me to the Indian driver's license registration and guide me."*
2. **Context Extraction:** The extension's `conversation-watcher.js` instantly detects this trigger. It reads the chat history to understand the exact context and goal.
3. **Autonomous Navigation (Via Agentic Search API):** 
   - **Intent Translation:** The background LLM (Groq) translates the conversational goal into a clean search query.
   - **URL Resolution:** Instead of heavy web scrapers, the system pings a dedicated, low-latency Search API (e.g., Serper.dev or Tavily) to instantly retrieve the top official URL.
   - **Validation & Execution:** The system verifies the URL isn't a blog or scam site, then uses `chrome.tabs.create()` to autonomously open the correct portal for the user.
4. **Seamless Handoff:** The user never leaves their workflow. They type in ChatGPT, a new tab opens autonomously to the correct, authenticated local environment, and the visual guidance begins immediately.

---

## 2. The Three-Tier Architecture

To solve these issues, the system will adopt a **Planner → Grounder → Executor** model.

### 1. The Planner (The Teacher)
* **Who:** ChatGPT, Claude, Gemini (operating in the "Teacher Tab").
* **Role:** High-level reasoning and task planning.
* **Input/Output:** Takes the user's prompt and outputs a high-level sequence of steps.
* **Note:** We *expect* these instructions to be slightly hallucinated or ungrounded.

### 2. The Grounding Orchestrator (The Agent)
* **Who:** The FolloMe Background Service Worker, powered by a fast, cheap multimodal model (e.g., Llama-3.2-11b-vision via Groq).
* **Role:** The "Reality Check". It bridges the gap between what the Planner *meant* and what actually exists on the target screen.
* **Capabilities:** It has access to a specific set of tools and operates within a strictly constrained state machine (see Rule Book below).

### 3. The Executor (The Pointer)
* **Who:** UI-TARS (for coordinates) + Content Scripts (`cursor-guide.js`, `overlay.js`).
* **Role:** Pixel-perfect execution and UI rendering.
* **Input/Output:** Takes the grounded, verified instruction from the Orchestrator and draws the visual bubble on the user's screen.

---

## The Hybrid "Senses" Approach

The Grounding Orchestrator dynamically switches between two modes of "seeing" the webpage to balance speed and accuracy:

1. **The Fast Path (DOM/A11y Extraction):** 
   Used for 90% of the web. The extension instantly extracts a lightweight Markdown representation of the page's interactive elements (buttons, links, inputs). It costs fractions of a cent and takes milliseconds.
2. **The Vision Path (Screenshot + UI-TARS):** 
   Used as a fallback for Canvas-based apps (Figma, Canva) or when the DOM approach fails. It relies on taking a compressed screenshot and asking the UI-TARS model for exact `[ymin, xmin, ymax, xmax]` coordinates.

---

## The Scout Pattern (Local Ghost Scout)

To completely eliminate user-facing latency and prevent the system from getting stuck on unexpected UI changes (e.g., hidden dropdowns), the architecture will employ a **Scout Pattern**.

Instead of waiting for the user to click and then trying to figure out what happened, the extension spawns a "Local Ghost Scout" that explores ahead of the user:
1. **The Hidden Tab:** When the Planner generates a sequence, the extension opens a hidden background tab (`chrome.tabs.create({ active: false })` or an Offscreen Document) on the user's actual Chrome browser.
2. **Authenticated Exploration:** Because this tab runs locally on the user's browser, it inherently shares the user's authentication state (cookies, active sessions). It can visit private pages securely without data ever leaving the machine.
3. **Pre-Mapping the Route:** The Grounding Orchestrator takes control of this hidden tab, clicks the necessary dropdowns, explores the DOM, and perfectly maps the exact route and element coordinates required to complete the task.
4. **Flawless Execution:** Once the Scout verifies the path, the hidden tab is closed, and the verified, zero-latency map is handed to the Executor to guide the user flawlessly on their visible tab.

---

## The Constrained Rule Book (State Machine)

To prevent Agentic Drift (infinite loops, runaway costs), the Grounding Orchestrator does *not* have free rein. It must operate under this strict deterministic loop:

### Phase 1: The Fast Check
1. **Rule 1:** When a new step arrives from the Planner, *always* run `get_interactive_dom()` first.
2. **Rule 2:** Ask the fast LLM: *"Is the element the Planner is talking about currently visible in this DOM string?"*
   * **If YES:** Skip Vision entirely. Pass the exact element details to the Executor.
   * **If NO:** Proceed to Phase 2.

### Phase 2: Agentic Investigation
3. **Rule 3:** The Agent is now allowed to call `take_screenshot()` and use the Vision Path to look for elements hidden from the DOM.
4. **Rule 4:** If the element is still not found, the Agent may call `scroll_page("down")`. 
5. **Rule 5 (The Circuit Breaker):** The Agent is allowed a **maximum of 2 scrolls**. If it still cannot deduce the next step, it is *forced* to call `abort_and_ask_user()`. It cannot loop infinitely.

---

## Smart Contextual Annotations (The Visual Layer)

To achieve a premium, native-Mac-app aesthetic (e.g., floating labels, glowing dashed bounding boxes), the Executor will employ a rich, dynamic overlay system.

1. **The Visual Engine (Shadow DOM & SVG):** The extension injects a full-screen, invisible `<svg>` and `<div>` layer using a Shadow DOM. This guarantees the host website's CSS won't break the annotations, and vice-versa.
2. **Scroll-Locked Tracking:** Using an optimized `requestAnimationFrame` loop and `getBoundingClientRect()`, the floating labels and dashed boxes will perfectly "stick" to their target elements even when the user scrolls the page.
3. **The Annotation Rule Book:** The Grounding Orchestrator does not just return a single pointer coordinate; it returns an array of contextual annotations based on ChatGPT's explanation. 
   - *Example Output:* `[{ type: "dashed_box", target: "#article-summary", label: "Key Concept" }, { type: "pointer", target: "#next-btn", label: "Click Next" }]`
4. **Visual Constraints:** To prevent overwhelming the user:
   - **Max Clutter:** A maximum of 3 annotations can be active on-screen simultaneously.
   - **Hierarchy:** Contextual highlights use subtle styling, while primary action pointers use vibrant, high-contrast styling (e.g., solid red/yellow).

---

## Handling Disruptive Popups (The Interruption Handler)

One of the biggest causes of agentic hallucination is when a website throws an unpredictable overlay (Cookie Banners, Newsletter Modals, Paywalls) that blocks the target element. The agent will handle these using an **Interruption Handler** built into the Scout.

1. **Pre-Flight Z-Index Check:** Before the Scout attempts to find the Planner's target element, it runs a fast DOM check for any active, high `z-index` overlays or `<dialog>` elements blocking the viewport.
2. **Autonomous Dismissal:** If a disruptive modal is detected, the Scout briefly pauses its primary mission. It feeds the modal's DOM to the fast LLM (Groq) with a specific prompt: *"Find the 'Close', 'Accept All', or 'X' button for this modal."*
3. **Clearing the Path:** The Scout clicks the close button to dismiss the popup. Because the Scout is a hidden background tab running ahead of the user, it clears these annoying popups *before* the user even sees them.
4. **Targeted Modals vs. Junk Modals:** The LLM is smart enough to distinguish between a junk popup (like a newsletter sign-up) and a necessary modal (like an authentication window required for the task). If it's an auth window, the Scout maps it as a required step and guides the user to log in.

---

## Design Philosophy & UI Minimalism

A core architectural principle for FolloMe is "Invisible Utility." The current UI is cluttered, overly complex, and leans too heavily into the "AI" aesthetic. The refactor demands a strict adherence to minimalism:

1. **The Extension Popup:** The popup menu (when clicking the extension icon) must be stripped down to the bare minimum. Because the extension is primarily initiated via the chat (the `#follome` trigger), the popup should only contain essential controls (e.g., Settings, Disable/Enable toggle). It should *not* look like a complex AI dashboard.
2. **The Guidance Cursor & Tooltips:** The current SVG cursor and tooltip bubbles are too heavy. They will be replaced with elegant, minimal design language:
   - **No Clunky Cursors:** Use subtle, native-feeling highlights (like the dashed boxes) rather than injecting a fake, animated mouse cursor.
   - **Clean Tooltips:** Tooltips should use simple typography (e.g., Inter or Roboto), stark contrast, and minimal padding. They should feel like a native operating system tooltip (e.g., macOS hints), not an obtrusive web popup.

---

## On-Page Contextual Querying (The Hotkey Input)

The `#follome` trigger handles initiation from within the ChatGPT tab. But what if the user is already on the target webpage (e.g., Figma or an Aadhaar portal) and needs to ask a follow-up question without switching tabs?

1. **The Fixed Hotkey:** The user presses a global hotkey (e.g., `Cmd/Ctrl + Shift + K`).
2. **Cursor-Anchored UI:** A sleek, minimal input window instantly pops up *exactly where the user's mouse cursor is currently located*. This keeps their eyes entirely on their work rather than hunting for an extension popup.
3. **Multimodal Input (Speech/Text):** The user can either type their question or speak it (using the browser's native SpeechRecognition API to convert voice to text instantly).
4. **The Latency Bridge:** Once submitted, the content script sends the query (along with a silent screenshot of the current page for context) to the background worker. The worker seamlessly relays this to the active ChatGPT tab. 
5. **Fluid UX:** To handle the inherent ChatGPT response latency, the cursor-anchored UI will instantly transition into a subtle, non-intrusive "Thinking..." or "Analyzing..." animation. The user knows the agent is working without being locked out of the page. Once the plan is ready, the Scout takes over and the visual annotations begin.

---

## Telemetry & Self-Healing (The Adaptability Layer)

A robust agentic system must handle inevitable failures (like ChatGPT changing its UI, or the agent hallucinating). The architecture incorporates two critical layers to ensure long-term stability:

1. **Self-Healing UI Parsers (Adaptability):** 
   Currently, the extension relies on hardcoded CSS selectors (e.g., `.markdown`) to scrape ChatGPT's responses. The moment OpenAI changes their UI, the extension breaks. 
   - **The Fix:** We drop hardcoded selectors. Instead, the extension grabs the raw, unstructured DOM of the chat area and feeds it to the fast, background LLM (Groq) with the prompt: *"Extract the latest instructions the AI gave to the user."* The LLM inherently understands the structure regardless of class names, making the extension immune to frontend UI updates from OpenAI or Claude.
2. **Error & Latency Tracking Hub:**
   If the agent hallucinates, fails to find a button, or the user clicks a "Wrong Step" feedback button, this data must not be lost.
   - **Error Logging:** The system will capture the exact state (the Planner's prompt, the Scout's DOM snapshot, and the resulting error) and log it to a telemetry database (e.g., Sentry or a custom backend).
   - **Latency Monitoring:** The system actively tracks the time taken for DOM extraction, Vision API calls, and LLM processing. If latency spikes beyond a configured limit (e.g., >3000ms), it triggers an alert and can fallback to faster reasoning to maintain fluid UX.
   - **Developer Dashboard:** This provides you (the developer) with an organized backlog of edge cases and performance bottlenecks, allowing you to continually patch the Rule Book and fix bugs based on real-world data.

---

## Execution Guardrails & State Management

When a user is being guided through a multi-step sequence, their natural instinct is to click around. If they click randomly while the agent is still explaining a step, it breaks the DOM state. The architecture solves this via strict Execution Guardrails:

1. **Screen Locking (The Safety Glass):** During an active explanation or annotation drawing phase, the extension injects a transparent, full-screen overlay (using `pointer-events: all`) to intercept and block stray clicks. The user *cannot* interact with the underlying page until FolloMe finishes its explanation and explicitly unlocks the target element for interaction.
2. **Predictive Click Management:** Once the user clicks the intended target, the extension intercepts that event. Instead of blindly hoping the page loads, the system *predicts* a UI mutation is imminent. It instantly pauses guidance, listens for DOM changes (via `MutationObserver`), and triggers a fresh visual state check (or screenshot) before allowing the next step to proceed.
3. **Step Rewinding (Time Travel):** Because the Scout maps out the entire route in advance (e.g., a 9-step sequence), the user's progress is tracked linearly. A minimal UI widget allows the user to click "Rewind." If they do, the system reverts its visual annotations to the previous step, allowing the user to re-read the explanation or double-check the context without breaking the agent's memory state.

---

## Required Toolset

The Background Service Worker will expose the following functions to the Grounding Orchestrator:

* `get_interactive_dom()`: Extracts lightweight Markdown of clickable elements.
* `take_screenshot()`: Captures and compresses the visible viewport.
* `scroll_page(direction)`: Scrolls the active tab exactly one viewport height.
* `query_ui_tars(visual_query, image)`: Requests bounding box coordinates from the Vision model.
* `draw_guidance(x, y, instruction)`: Sends the execution command to the content script.
* `abort_and_ask_user(reason)`: Safely escapes the loop and prompts the user for manual intervention.

---

## Lessons from Production (Lyto Chrome Agent)

Based on an architectural analysis of a production-ready agent (Lyto Chrome Agent), our current architecture exhibits several key flaws that must be addressed to ensure enterprise-level robustness:

1. **Reliance on DOM APIs vs. Chrome DevTools Protocol (CDP)**
   Currently, we rely on standard DOM events injected via content scripts to observe and interact with the page. This approach is brittle, as modern web applications (React, Canvas, iframes) frequently block or ignore synthetic DOM events. We must transition to using `chrome.debugger` (CDP) to dispatch native-level mouse and keyboard events (e.g., `Input.dispatchMouseEvent`).

2. **Parsing DOM instead of Accessibility Tree (AXTree)**
   We are heavily reliant on raw HTML DOM parsing or basic traversal for grounding. Lyto utilizes the Accessibility Tree (via CDP's `Accessibility.getFullAXTree`), which provides a clean, semantic, and token-efficient representation of interactable elements, automatically filtering out layout junk. Implementing AXTree extraction is critical for reliable model reasoning.

3. **Missing Abstraction / Heavy Client Architecture**
   Managing the agent loop, state tracking, and complex LLM orchestration entirely within the browser extension leads to performance degradation, MV3 service worker timeouts, and security risks. We need a "Thin Client" architecture where the extension acts solely as the eyes and hands, while a dedicated backend handles the orchestration loop.

4. **Lack of Edge-Case Handling (Canvas/Iframes)**
   Our current approach fails entirely in applications like Google Docs and Sheets that render off-DOM. Lyto handles these by forcing Focus Emulation (`Emulation.setFocusEmulationEnabled`) and sending raw keyboard/CDP events mapped to the specific application's quirks. Our architecture must incorporate specialized interaction strategies for non-DOM-standard websites.

---

## Lessons from Production (Morph Chrome Extension)

An architectural analysis of the **Morph Chrome Extension** (a declarative UI transformer that allows users to reshape websites via natural language prompts) reveals highly sophisticated solutions to our current architectural bottlenecks—specifically regarding token latency, security, and surviving UI changes on external sites like ChatGPT and Claude.

1. **Context Compression (Solving LLM Understanding & Latency)**
   Sending raw HTML DOM to an LLM blows up the token limit and confuses the model. Morph solves this by extracting a **pruned, indented text tree** (capturing only visible tags, IDs, ARIA roles, and a 50-character text preview) instead of raw HTML. This is why Morph understands casual human language so well: the backend LLM "sees" an exact semantic map of the screen alongside the user's prompt. We must update `get_interactive_dom()` to use this exact context pruning strategy.

2. **Self-Healing UI Parsers (Solving the ChatGPT/Claude UI Update Problem)**
   Currently, we extract ChatGPT's instructions using hardcoded CSS selectors (e.g., `.markdown`). If OpenAI changes their UI class names, our extension breaks. 
   - **The Morph Solution:** Morph utilizes **"Self-Healing Anchors"**. Instead of saving a brittle CSS selector, it saves a deep structural fingerprint of the element (tag, ID, ARIA role, inner text, nth-child). If a CSS selector fails, the extension falls back to searching the DOM for this structural fingerprint. 
   - **Our Implementation:** We will ditch hardcoded CSS classes. Instead, we will serialize the ChatGPT tab into the compressed text tree (mentioned above), feed it to a fast local model (like Groq), and ask the model to map the UI structurally. The parser will become completely immune to OpenAI/Anthropic frontend redesigns.

3. **Structured DSL Output (Zero-Trust Security)**
   Instead of asking an LLM to generate raw JavaScript code or complex JSON that we blindly execute, Morph's backend returns a strict Domain Specific Language (DSL) object (e.g., `hide`, `setText`). The extension locally validates and heavily sanitizes these commands to prevent XSS. We must adopt this Zero-Trust execution model, forcing the LLM to reply strictly with predefined commands (`draw_guidance`, `scroll`, `abort`) rather than trusting its output implicitly.

4. **SPA Idempotent Reconciliation (Surviving React Re-renders)**
   Modern Single Page Applications (like React or Vue) constantly re-render the DOM, which destroys visual modifications. Morph survives this by implementing a `reconcile()` loop that continuously re-asserts its UI changes using specific tracking attributes. Our guidance tooltips and visual highlights must adopt a similar reconciliation loop so they don't disappear instantly when a page updates its state.

5. **Natural Language Translation via Fast LLMs (Dropping the JSON Requirement)**
   Currently, we struggle to force ChatGPT to output strict JSON arrays for its plans, which often breaks or degrades the chat experience. Morph proves that the primary agent doesn't need to output code or JSON if we use a translator layer. 
   - **The Morph Approach:** Morph's backend can take a completely casual, natural language instruction (e.g., "make the big title red") and perfectly map it to a structural UI change because it compares the natural text against the compressed semantic DOM tree.
   - **Our Implementation:** We will let ChatGPT/Claude speak in their natural, conversational tone (e.g., "First, click on the Login button at the top right."). The extension will capture this natural sentence and the compressed DOM tree, and feed them into our **cheap, ultra-fast Grounding Orchestrator (e.g., Llama-3 8B via Groq)**. This fast model will perform the translation, outputting the strict, zero-trust DSL (`draw_guidance(login-btn)`) required for execution. This solves the JSON formatting issue, keeps the AI conversational, and leverages a high-speed/low-cost model for the heavy structural mapping.

---

## Lessons from Production (Morph Tab Chrome Extension)

An analysis of the **Morph Tab** extension (an AI-powered next-action prediction agent) offers critical insights into state tracking and latency optimization, specifically how it solves the problem of detecting UI changes without repeatedly extracting the entire DOM.

1. **Incremental State Streaming (`rrweb`)**
   Currently, we rely on a manual `MutationObserver` or taking sequential screenshots to detect if the user's click caused a UI change. This is brittle and slow. 
   - **The Morph Tab Solution:** It uses `rrweb` (Record and Replay Web), an industry-standard library, to capture an initial DOM snapshot and then stream tiny, incremental JSON patches representing exact DOM mutations and user events (clicks, scrolls).
   - **Our Implementation:** Instead of blindly re-extracting `get_interactive_dom()` on every click, we can integrate an incremental tracking approach (like `rrweb`) to maintain a perfectly synced virtual DOM state in our Background Service Worker. This drastically reduces the data processing overhead when tracking user progress.

2. **WebSockets for Ultra-Low Latency**
   If we are translating natural language to DSL in real-time (as proposed in the previous section), setting up a new REST API HTTP connection for every step introduces hundreds of milliseconds of TLS handshake latency. Morph Tab avoids this by maintaining a persistent WebSocket connection (`wss://`) to its backend. 
   - **Our Implementation:** To ensure FolloMe provides a seamless, instant experience without lag across any operating system, the connection between the Chrome extension and our Grounding Orchestrator backend should utilize WebSockets for persistent, ultra-fast communication.

3. **Debounced Event Buffering**
   Morph Tab maintains an `EVENT_BUFFER_SIZE` of 100 but uses a `PREDICTION_DEBOUNCE_MS` (500ms). It only asks the LLM for a prediction after the user stops typing/clicking for 500ms. If we transition to a proactive monitoring state (where the Scout maps routes in the background), we must adopt this debouncing strategy to avoid spamming the Grounding Orchestrator (and running up API bills) during fast user activity.

---

## Zero-Shot Navigation: Read-Only Predictive Routing

A core architectural challenge for FolloMe is the **"Cold Start Problem"** on complex, highly-stateful websites (e.g., Amazon Seller Central or internal dashboards). How do we guide the very first user on a novel website without pre-recorded creator paths, and without the AI blindly guessing and breaking the user's session?

We must acknowledge a fundamental rule of web automation: **An invisible background agent cannot safely "explore" an authenticated production environment by clicking buttons, as it risks executing destructive actions (e.g., logging out, making purchases, deleting data).**

### 1. The Strategy: Read-Only Prediction (Human-in-the-Loop)
To completely eliminate the risk of destructive background actions while providing a flawless zero-shot experience for the first user, FolloMe will operate strictly as a **Read-Only Predictor**:

1. **High-Intelligence DOM Analysis:** When a user asks a complex navigational question, the extension captures the pruned, semantic DOM tree (`context.js`) and a lightweight viewport screenshot.
2. **Zero-Shot Prediction:** This context is sent to a frontier model (e.g., Claude 3.5 Sonnet or GPT-4o). Because these models possess deep structural understanding, they do not need to "test click". The model analyzes the DOM and predicts with extremely high accuracy which element represents the correct path.
3. **Visual Handoff:** The model generates the strict DSL (`draw_guidance(target)`). The extension highlights the element on the user's screen.
4. **Human Safety Layer:** The AI never clicks. The human user executes the click. This ensures absolute safety. Once clicked, `rrweb` streams the DOM mutation back to the model, which instantly recalibrates and predicts the next step, acting as a real-time GPS navigation system.

### 2. Economics & Optimization (Frontier Model Costs)
Relying on frontier models for step-by-step prediction requires strict token management to remain economically viable for a bootstrapped startup.

- **Token Compression:** By utilizing `context.js` to strip out raw HTML/CSS and only sending the semantic text tree alongside a compressed screenshot, we cap the input context at roughly ~5,000 tokens per call.
- **Context Caching:** We will heavily leverage Prompt/Context Caching (e.g., Anthropic's caching for Claude 3.5). Since the base DOM structure and system prompt remain largely identical across sequential steps in a single session, cached tokens receive a ~90% cost reduction.
- **Cost Structure:** With compression and caching, a complex 5-step navigation sequence on a frontier model costs approximately **$0.017 per step** (under 2 cents). This translates to roughly **$1.70 per 100 complex steps**, making it highly cost-effective for solving novel edge cases, while our ultra-fast Groq/Llama-3 models handle routine, cheap translations in the background.

---

## Execution & Rendering Engine (Learnings from TipTour)

An architectural analysis of the **TipTour** Chrome Extension offers exact solutions for executing UI highlights and extracting semantic data without compromising the user experience with security warnings.

1. **Eliminating the Yellow Banner & Extracting Accessibility Trees:**
   - Chrome's security model makes it **physically impossible** to hide the yellow warning banner ("started debugging this browser") if `chrome.debugger` (CDP) is attached. 
   - Since FolloMe uses Read-Only Predictive Routing (the AI highlights, the human clicks), we do not need CDP to force clicks.
   - To extract the Accessibility Tree without CDP, we will inject a robust JavaScript snippet directly into the page (via content scripts) that manually reconstructs the accessibility tree. By reading `element.getAttribute('aria-label')`, checking `role`, mapping implicit roles, and calculating visibility, we generate a highly accurate "Pseudo-Accessibility Tree" using standard DOM APIs. This provides the LLM with deep semantic understanding while guaranteeing **zero yellow banners**.

2. **Multi-Factor Target Resolution (Self-Healing Anchors):**
   - When the LLM predicts an element to interact with, we will fingerprint it using a 5-layer redundancy model. We will capture:
     - `selector`: CSS selector (`data-testid`, specific classes).
     - `xpath`: Absolute DOM path structure.
     - `ariaRole` & `accessibleName`: The accessibility tree node (critical for modern React/SPA apps).
     - `text`: Inner text content.
   - If the DOM changes slightly on the next page load, the Orchestrator will score these 5 factors to find the closest match.

3. **Visual Context Downscaling (Client-Side Canvas):**
   - We will use `chrome.tabs.captureVisibleTab` to take screenshots for the vision model, but we will inject an off-screen HTML5 `<canvas>` to instantly downscale the image (e.g., to 600x360, 60% quality JPEG) *before* sending it over the network. 
   - This shrinks a massive 4MB raw screenshot into a ~50KB payload, drastically dropping network latency and LLM token costs.

4. **The Ghost Cursor & Tooltip UI:**
   - The AI's guidance will be rendered via a lightweight, absolute-positioned `<div>` injected into the page with a maximum `z-index: 2147483647`.
   - We will use a custom SVG for the "Ghost Cursor".
   - Motion will be smoothed using native CSS `transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)`. 
   - Tooltips will be standard HTML fragments attached dynamically relative to the cursor's coordinates.
