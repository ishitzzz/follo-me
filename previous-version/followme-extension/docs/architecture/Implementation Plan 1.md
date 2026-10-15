# Master Architecture & Implementation Plan: The FolloMe Agent

This document unifies the previous "Read-Only Predictor" architecture with the new "Agentic Executor" capabilities. It outlines exactly what remains the same, what is new, and how the system intelligently integrates with LLM chatbots (ChatGPT/Claude), handles extreme edge cases, and provides a frictionless user experience.

## 1. Architectural Sync: Old vs. New

**What remains the same (The Foundation):**
- **DOM Extraction & `context.js`:** We are still using the highly optimized Pseudo-Accessibility Tree (Lyto-style). We strip out CSS/HTML junk and create an indented, semantic text map of the page to compress context and save tokens.
- **The "Little Brain":** We are still using the Groq API for ultra-fast, cheap processing in the background.
- **On-Page Contextual Querying (Cursor UI):** The user can summon a minimal UI directly beside their cursor using a hotkey (`Cmd/Ctrl + Shift + K`) to ask questions via text or voice without switching tabs.

**What is new (The Agentic Layer):**
- **The Hybrid Executor:** We are adding the ability to *click*. 
  - *Standard Web:* Uses Lyto's synthetic event chain (`pointerover` -> `mousedown` -> `click()`) to avoid CDP banners.
  - *Canvas Apps (Figma):* Dynamically falls back to TipTour's `chrome.debugger` (CDP) for native coordinate clicking, immediately detaching after.
- **The Chatbot Interpreter:** FolloMe now acts as an invisible bridge between the user and ChatGPT/Claude, autonomously passing data back and forth.

---

## 2. Model Hierarchy & Edge Case Handling

We utilize a tiered LLM approach to balance lightning-fast speed, low cost, and deep reasoning for complex edge cases.

### Tier 1: The Interpreter & Scraper (Groq Llama-3 8B)
- **Role:** The ultra-fast "Little Brain" running in the background.
- **Use Case:** It constantly eavesdrops on the chat transcript. Because it can process 800+ tokens a second, it effortlessly strips out conversational fluff and compiles strict JSON action plans. It also handles basic extraction tasks (e.g., finding the "Next" button in the DOM).

### Tier 2: The Complex Grounder (Claude 3.5 Sonnet / GPT-4o)
- **Role:** The "Read-Only Predictor" for extreme edge cases (e.g., highly complex, authenticated environments like Amazon Seller Central or Aadhaar portals where an errant click could be destructive).
- **Use Case:** If the task is too complex for Llama-3, FolloMe falls back to Claude. We send the compressed semantic text tree (via `context.js`) and a lightweight screenshot to Claude. Claude analyzes the massive context and generates the exact execution path without guessing.
- **Cost Optimization:** By heavily leveraging Prompt Caching (caching the DOM structure and system prompts), we drop the cost of these complex frontier-model calls by ~90%, making it economically viable for hard edge cases.

---

## 3. The Agentic Orchestration Workflow

We are building a **Trigger-Based Conversational Interpreter**. FolloMe operates entirely on behalf of the user, requiring zero prompt injections.

### Phase 1: The Trigger (Dual-Mode)
To completely prevent the LLM from getting confused by explicit text tags (and to avoid React state-sync issues when modifying inputs), FolloMe uses a frictionless dual-trigger system:

1. **Primary: Zero-Trigger Eavesdropper (Auto-Detect)**
   - The Local Brain (Groq) passively monitors the chat. If the LLM generates an actionable UI workflow (e.g., "1. Go to Amazon... 2. Click Search..."), FolloMe automatically injects a tiny UI button: *"✨ Execute this for me"*. No manual triggers needed.
2. **Fallback: Empty Input Hotkey (Manual Force)**
   - If the auto-detect fails or the user wants to force an action upfront, they type `/` into an *empty* input box. A small menu appears ("Press `Tab` to activate FolloMe"). Hitting `Tab` clears the slash and highlights the input box with a subtle glow, arming the extension for the next sent message without modifying the text sent to the LLM.

### Phase 2: The Interpreter (Two-Step Context Gathering)
To prevent FolloMe from losing deep context from earlier in the conversation, we implement a two-step context gathering system: **Global Summarization** followed by **Dynamic Backward Semantic Collection**.

#### 1. The Global Summarizer (The Macro Context)
Before hunting for specific UI actions, the watcher extracts a massive chunk of the chat (e.g., up to the last 50 messages) and feeds it to a fast summarizer (Groq Llama-3 8B) to generate a dense 4-5 line paragraph. This ensures overarching goals (e.g., the user's state, specific accounts, emotional struggles) are permanently captured as a "Global Anchor".

#### 2. Dynamic Backward Semantic Collection (The Micro Context)
Next, `conversation-watcher.js` acts like a smart reader going backwards in time to find the *immediate* task:
1. **Start at the Bottom:** It grabs the very last AI message.
2. **Read Upwards:** It begins reading the chat history backwards.
3. **Stop Conditions:** It stops collecting history *only* when it detects a hard semantic shift (Topic Disconnect) or it has collected all necessary context for the immediate task (Context Complete).

#### 3. The Micro-Chunk Summarizer & Translation
- **Compression:** If the backward-collected chunk is large, it passes through the fast summarizer to extract just the actionable intent (a dense ~200-token micro-context block).
- **Execution:** Both the Global Summary and the Micro-Context Summary are fed into the final Action Extractor prompt to compile a strict JSON execution plan.

### Phase 3: The Minimal UI & Execution
**FolloMe does not show the user the raw JSON workflow.**
- A sleek tooltip/overlay appears on the screen asking: 
  > *"Do you want me to work this out for you?" [Yes] / [No]*
- If the user clicks "Yes", FolloMe takes over. It switches tabs, runs the Hybrid Executor, and completes the clicks based on the JSON plan.

### Phase 4: Fully Autonomous Reporting (FolloMe Hits Send)
Once FolloMe completes the task or gets stuck (e.g., hits a CAPTCHA), it returns to the ChatGPT tab to report back *autonomously*.
- It types a perfectly normal human message directly into the `#prompt-textarea` (e.g., *"I checked Amazon, but everything is above 3,000 rupees. What should I do here?"*).
- It automatically captures a screenshot of the Amazon tab and attaches it to the input box.
- **Autonomous Dispatch:** The user does **not** need to hit send. FolloMe programmatically clicks the "Send" button in the ChatGPT UI, continuing the background conversation loop automatically.

### Phase 5: On-Page Communication (The Cursor Chat)
If the user is on the Amazon tab and has a doubt, they do not need to manually switch back to the ChatGPT tab.
- They press the hotkey. The mic/text input opens right next to their cursor.
- They speak/type their question. FolloMe grabs their query, switches to the ChatGPT tab in the background, inputs the query, hits send, waits for ChatGPT's response, and brings the guidance back to the user's active screen.

---

## 4. The Offscreen "Brain" (MultiOn-Style Architecture)

To ensure this multi-tab, multi-step process doesn't break when Chrome puts the extension to sleep, we are strictly adopting MultiOn's Offscreen Document architecture:
1. **Always-Awake Execution Thread:** On initialization, the background script spawns an `offscreen.html` document. This document runs `offscreen.js` and serves as the "Little Brain".
2. **State & LLM Orchestration:** Because Offscreen Documents do not fall asleep like Service Workers, the agent's cross-tab state, `rrweb` mutation tracking, and long-running LLM inferences (Groq) happen safely inside this document.
3. **Service Worker as Router:** The `background.js` Service Worker merely acts as a message router, waking up the offscreen document if needed and passing messages between the content scripts (tabs) and the Brain.

---

## 5. Proposed Code Changes

#### [MODIFY] [utils/context-extractor.js](file:///Users/ishitjain/followme-extension/utils/context-extractor.js)
- Maintain the fast Lyto-style Pseudo-AXTree DOM extraction.
- Add the `<canvas>` detector to flag if a site requires TipTour's CDP fallback.

#### [NEW] [brain/hybrid-executor.js](file:///Users/ishitjain/followme-extension/brain/hybrid-executor.js)
- The execution controller. Dispatches synthetic DOM clicks for 95% of sites. Attaches `chrome.debugger` for Canvas-flagged sites.

#### [NEW] [brain/conversational-interpreter.js](file:///Users/ishitjain/followme-extension/brain/conversational-interpreter.js)
- Uses Groq Llama-3 8B to parse conversational fluff into JSON execution arrays.
- Routes complex UI reasoning tasks to Claude 3.5 Sonnet.

#### [NEW] [watchers/conversation-watcher.js](file:///Users/ishitjain/followme-extension/watchers/conversation-watcher.js)
- Uses `MutationObserver` to watch the ChatGPT/Claude DOM for `#followme` triggers.
- Injects the minimal *"Do you want me to work this out for you?"* UI tooltip.

#### [NEW] [adapters/chatgpt-adapter.js](file:///Users/ishitjain/followme-extension/adapters/chatgpt-adapter.js)
- Simulates natural typing, attaches screenshots, and **programmatically triggers the Submit/Send button**.

#### [NEW] [watchers/cursor-ui.js](file:///Users/ishitjain/followme-extension/watchers/cursor-ui.js)
- The Hotkey listener (`Cmd+Shift+K`) that injects the minimal chat/mic input next to the user's cursor for on-page querying.

#### [NEW] [offscreen.html](file:///Users/ishitjain/followme-extension/offscreen.html) & [brain/offscreen.js](file:///Users/ishitjain/followme-extension/brain/offscreen.js)
- Implements the MultiOn-style Offscreen Document to track cross-tab state and execute LLM reasoning loops reliably.

#### [NEW] [debug.html](file:///Users/ishitjain/followme-extension/debug.html)
- A trace window to visualize the agent's internal state (JSON plans, DOM tree) for developer debugging and user trust.

---

# Deep Dive: The FolloMe Master Architecture & Agentic Sync

This section provides a highly detailed breakdown of the FolloMe architecture. It maps exactly where every idea originated, how the agents execute tasks with peak token efficiency, when we use specific tools (like CDP or Vision), and how we keep API costs near zero.

---

## 6. The Architectural Sync: Origins & Learnings

To build the ultimate autonomous agent, we have synced the best concepts from four distinct Chrome extensions. Here is exactly what we are borrowing and from where:

### A. Learnings from Lyto Chrome Agent
- **Synthetic Clicks (The Anti-Banner Strategy):** Lyto avoids the CDP "yellow banner" by chaining `PointerEvent` -> `MouseEvent` -> `click()`. We use this for 95% of standard web interactions.
- **Pseudo-AXTree Extraction:** Lyto proved that raw HTML is garbage for LLMs. We use their method of extracting the Accessibility Tree (ARIA roles, visible text) into a token-efficient format.

### B. Learnings from TipTour
- **Dynamic CDP for Canvas:** TipTour proved that Synthetic Clicks fail on `<canvas>` (like Figma or Google Docs). We use TipTour's learning: dynamically attach `chrome.debugger`, dispatch the OS-level mouse coordinate, and instantly detach it.
- **Client-Side Image Downscaling:** TipTour shrinks 4MB screenshots to 50KB using an off-screen HTML5 `<canvas>` before hitting the API. We adopt this to drastically cut Vision LLM costs.

### C. Learnings from Morph
- **Context Compression (Indented Text Trees):** Morph strips out 99% of DOM junk, turning a webpage into a tiny Markdown-like tree. We use this to keep our prompt sizes under 5,000 tokens.
- **Self-Healing Anchors:** Morph doesn't use brittle CSS selectors (like `.btn-primary`). It asks the LLM to find the element based on its structural position and text. If OpenAI updates their UI, FolloMe won't break.

### D. Learnings from Morph Tab
- **Incremental State Streaming (`rrweb`):** Morph Tab doesn't re-scan the entire page after every click. It uses `rrweb` to stream tiny JSON patches of DOM mutations. We use this to **predict what changed** without paying for a new LLM inference or taking a screenshot after every single click.

### E. Learnings from MultiOn
- **Offscreen Documents:** MultiOn uses an Offscreen Document to prevent the Service Worker from sleeping, ensuring long-running LLM inferences and cross-tab tasks never fail unexpectedly.
- **Sandboxed UI via Web Accessible Resources:** They inject their assistant UI as an iframe loaded from a web accessible resource to prevent the host page's CSS from breaking it.
- **Debug Trace UI:** Providing a dedicated `debug.html` to show the agent's internal state builds immense trust.

---

## 7. The Agentic State Machine: How It Works & Tools Provided

FolloMe is not a chaotic agent that loops randomly. It operates on a strict, cost-optimized State Machine.

### The Tools Provided to the Agent:
1. `get_compressed_dom()`: Returns the lightweight Morph-style text tree.
2. `check_mutations()`: Checks the `rrweb` buffer to see if the page actually changed since the last action.
3. `click_element(target_id)`: Dispatches Lyto-style synthetic clicks.
4. `trigger_cdp_click(x, y)`: Attaches the debugger, clicks the coordinate, detaches.
5. `type_text(target_id, text)`: Simulates human typing.
6. `take_vision_screenshot()`: Takes a downscaled 50KB screenshot (High Cost - Restricted).
7. `report_to_commander(msg, attach_image)`: Types a natural message into the ChatGPT tab and hits send.

### The Agentic Loop (Cost-Optimized):
When ChatGPT issues a goal (e.g., "Buy the shoes"), the FolloMe **Local Brain** (Groq Llama-3 8B) takes over:

1. **The Fast Check (Token Cost: ~0.0001¢):** The agent calls `get_compressed_dom()`. The LLM checks if the target element (e.g., "Add to Cart") is in the text.
2. **Action & Wait (Token Cost: 0¢):** The agent calls `click_element()`. Instead of immediately rescanning the page, the agent calls `check_mutations()`. If `rrweb` detects a loading spinner or a page transition, the agent *waits* for the network to idle. It does not waste tokens guessing.
3. **The Vision Fallback (Token Cost: ~0.01¢):** ONLY if the target element is NOT found in the DOM (e.g., it's a Canvas app or hidden behind a shadow DOM), the agent is permitted to call `take_vision_screenshot()`. It sends the image to **Claude 3.5 Sonnet**, gets the exact `[x, y]` coordinates, and calls `trigger_cdp_click(x, y)`.
4. **The Circuit Breaker:** If the agent fails 3 times, it halts and calls `report_to_commander()` to ask the human for help.

---

## 8. Triggering the CDP Stack (Canvas Apps)

**How do we know when to use CDP?**
CDP (`chrome.debugger`) triggers the ugly yellow banner, so we avoid it at all costs. We only trigger it under two specific conditions:

1. **Canvas Detection Heuristic:** When `get_compressed_dom()` runs, a lightweight JavaScript script analyzes the page. If it detects that a `<canvas>` element takes up more than 50% of the viewport (like Figma), it flags the `contextSnapshot` with `requires_cdp = true`.
2. **Vision Fallback:** If the DOM extraction fails to find interactive elements (e.g., a heavily obfuscated Flash or WebGL site), the agent defaults to the Vision Path. Since Vision models return coordinates `[x,y]` rather than DOM IDs, the agent *must* use CDP to click those physical pixels on the screen.

When `requires_cdp` is true, the agent executes `chrome.debugger.attach`, fires `Input.dispatchMouseEvent`, and immediately calls `chrome.debugger.detach`.

---

## 9. Cost Management & Token Optimization

To make this agent economically viable for a bootstrapped startup, we aggressively manage costs through tiered models and strict data input rules:

1. **The "Little Brain" Workhorse:** 95% of tasks (understanding the ChatGPT conversation, scanning the DOM for buttons) are routed to **Groq Llama-3 8B**. This costs fractions of a penny per million tokens.
2. **Blind Until Necessary (No Screenshots):** By default, the agent is BLIND. It relies entirely on the Morph-style text tree. Images cost 10x to 100x more tokens than text. Screenshots are only taken when the DOM fails or when reporting an error back to ChatGPT.
3. **Mutation Prediction (`rrweb`):** Instead of paying the LLM to figure out if a click worked, we use `rrweb` to track exact DOM nodes. If a node is added/removed, we know the click worked. Zero tokens spent.
4. **Context Caching (For Claude 3.5):** When we are forced to use the expensive Vision model (Claude 3.5 Sonnet) for complex Canvas clicking, we leverage Anthropic's Prompt Caching. Since the system prompt and base UI rarely change, caching drops the token cost by 90%, allowing us to handle tough edge cases for less than 2 cents a step.

---

## 10. Execution Modes & Error Handling

To provide the best user experience and safety, FolloMe adopts a **Dual-Mode System** (similar to TipTour):
1. **Autonomous Mode:** The agent acts independently, moving the cursor and clicking/typing at superhuman speed to complete the task.
2. **Copilot Mode (Human-in-the-Loop):** The agent does not click. Instead, it uses a visual overlay to highlight the next button and waits for the human to physically click it before proceeding to the next step. 

**Error Handling & Retries (Fully Autonomous):**
Unlike hardcoded automation tools, FolloMe uses a dynamic, silent self-correction loop to prevent wasting API credits or bothering the user:
* **Zero-Cost DOM Polling:** The background script runs a local `setInterval` loop to wait for elements. This costs 0 API credits and does not ping the LLM.
* **Dynamic RRWeb Waiting:** Instead of a strict 5-second timeout, the agent monitors RRWeb mutations. If the page is actively transitioning or showing a loader, it pauses the timeout until it detects "Network Idle" (no mutations for 500ms).
* **3-Tier Fallback Strategy:** If an action fails (e.g., target element not found), the agent executes its fallback cascade:
  1. **Scroll & Hunt:** Auto-scroll up/down up to 3 times to find the element.
  2. **Vision Fallback:** Switch to Claude 3.5 Vision for physical coordinates (bypassing DOM).
  3. **Graceful Abort:** After exhausting **3 total LLM retries**, the agent marks the task as FAILED, outputs a final report to ChatGPT, and terminates the session. It never pauses to ask the user for manual UI help.
