# Unified Master Blueprint: Multi-Model Architecture & Pipeline Specification

This blueprint merges your original multi-model pipeline with the technical upgrades we have established—including the dual-engine execution model, client-side relay, zero-friction WebSocket bridge, dynamic tool routing, and three-tier memory architecture.

---

## 1. The Multi-Model Pipeline ("Enriched Context" Flow)

Your original sensory-and-reasoning hierarchy remains intact, upgraded with dedicated DOM and Canvas execution paths.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        USER TRIGGER & CAPTURE                          │
│         (ChatGPT text, active tab DOM, screenshot, extension input)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   STEP A: INTENT & STRUCTURING                         │
│            Grok (Fast Intent) ──► Qwen 2.5 72B (Structuring)          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               STEP B: INTELLIGENT NAVIGATION PIPELINE                   │
│              Crawl4AI Prefetch Tool (URL Resolution & 404 Check)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       STEP C: EXECUTION PATHWAY                        │
│   ┌───────────────────────────────┐   ┌────────────────────────────┐   │
│   │   DOM / Standard Web Apps     │   │   HTML5 Canvas / Design    │   │
│   │   (Midscene.js + GPT-4o Mini) │   │   (UI-TARS + Qwen-VL)      │   │
│   └───────────────┬───────────────┘   └─────────────┬──────────────┘   │
└───────────────────┼─────────────────────────────────┼──────────────────┘
                    │ (If Success)                    │ (If Failure / Blocker)
                    ▼                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    STEP D: ULTIMATE REASONER                           │
│      DeepSeek R1 (Strategic Decision, Failure Recovery & Re-Planning)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Step A: Capture, Intent Parsing & Structuring
* **Trigger:** The extension activates via user prompt, active tab inspection, or a generated ChatGPT plan.
* **Grok:** Acts as the fast, low-latency entry filter to classify the initial intent (e.g., *Is this web automation, research, design, or email?*).
* **Qwen 2.5 72B:** Receives raw chat history, DOM metadata, and screenshots. It structures this data into a clean, step-by-step master plan and formats visual metadata.

### Step B: The Intelligent Navigation Pipeline ("The Link Factor")
* **The Problem:** LLMs often hallucinate URLs or output broken/vague links (e.g., `404 Not Found` or plain text like "Go to Figma").
* **Crawl4AI URL Resolver Tool:** Before any navigation occurs, Qwen routes target links through a dedicated URL Resolver tool powered by Crawl4AI in `prefetch` mode.
* **Execution:** Crawl4AI verifies whether the link resolves, extracts the canonical URL, and checks HTTP status codes in the background without launching a heavy headless browser. If a link is missing or broken, it executes a light search query to retrieve the verified, official URL before proceeding.

### Step C: Sensory Execution (Dual-Engine Routing)
Once a clean target URL is loaded, execution branches depending on the target page's underlying technology:

#### Pathway 1: Standard Web Pages (Midscene.js + GPT-4o Mini)
* Used for YouTube, Google Docs, Gmail, form filling, and standard DOM structures.
* **Midscene.js (Client-Side):** Takes a local snapshot of the active or hidden background tab and extracts a compact Accessibility Tree.
* **GPT-4o Mini (The Operator):** Receives the Accessibility Tree alongside the immediate action command. GPT-4o Mini identifies the exact interactive element ID and returns a JSON command.
* **Native Execution:** Midscene dispatches the click or keypress natively via the Chrome extension context.

#### Pathway 2: HTML5 Canvas & Complex Visual Apps (UI-TARS + Qwen-VL)
* Triggered when interacting with `<canvas>` elements (e.g., Figma) where no DOM node IDs exist.
* **UI-TARS:** Analyzes the viewport screenshot to calculate exact visual $(x, y)$ coordinates for tools, buttons, or canvas areas.
* **Qwen-VL:** Simultaneously inspects the screenshot to verify state (e.g., *"Rectangle tool selected, canvas is clear"*).
* **Scaling & Execution:** The extension normalizes coordinates against `window.devicePixelRatio` and dispatches native CDP mouse drag/click events.

### Step D: The Ultimate Reasoner (DeepSeek R1)
* **Role:** DeepSeek R1 does not write DOM queries or calculate visual coordinates. It acts purely as the high-level strategic brain.
* **Activation:** Invoked when Pathway 1 or Pathway 2 encounters an obstacle (e.g., `ElementNotInteractable`, modal overlay, unexpected captcha, or UI-TARS failure).
* **The Payload:** DeepSeek receives:
  * Static Anchor Memory (Original user goal + master plan).
  * Qwen's structured execution state.
  * UI-TARS thought log or Midscene failure error.
  * Qwen-VL's visual state analysis.
* **Decision Loop:** DeepSeek R1 evaluates the failure, adjusts the strategic path, and sends an updated directive back down to the execution layer. If more context is needed, it triggers a background tool to query ChatGPT, feeding the response back into Qwen to continue the loop.

---

## 2. Dynamic Tool Router & 100+ Tool Storage Strategy

To prevent blowing DeepSeek R1's context window or causing "schema paralysis" with dozens of tool definitions, tools are stored and retrieved using a two-tier vector routing system.

```
                              ┌───────────────────────────────┐
                              │  Massive Tool Library (100+)  │
                              │  (Stored in Vector DB / JSON)  │
                              └───────────────┬───────────────┘
                                              │
                                              ▼
┌──────────────────────────────┐     ┌────────────────────────────────┐
│   DeepSeek R1 Intent State   │────►│    Semantic Tool Router        │
└──────────────────────────────┘     │  (Vector Match Top 3 Tools)    │
                                     └────────────────┬───────────────┘
                                                      │
                                                      ▼
                                     ┌────────────────────────────────┐
                                     │  Active Context Window (4)     │
                                     │  • Tool 1 (Top Match)          │
                                     │  • Tool 2 (Top Match)          │
                                     │  • Tool 3 (Top Match)          │
                                     │  • search_tool_library         │
                                     │    (Safety Hatch)              │
                                     └────────────────────────────────┘
```

### Tool Library Storage
* All 100+ specialized tools (e.g., `switch_tab`, `close_tab`, `verify_url`, `fill_form_field`, `canvas_drag`) are stored as JSON schemas inside a light vector index (or local JSON manifest on Cloudflare Workers).

### Retrieval Flow
1. **Semantic Search Filtering:** When DeepSeek R1 states its current intent, the Tool Router runs a fast vector similarity search against the Tool Library to find the top 3 most relevant tool schemas.
2. **The "3 + 1" Schema Injection:** DeepSeek R1 is prompted with exactly 4 tools:
   * **Tools 1, 2, 3:** The top semantic matches provided by the router.
   * **Tool 4 (`search_tool_library`):** A permanent safety hatch tool.
3. **Safety Hatch Execution:** If the Tool Router selects the wrong tools, DeepSeek R1 invokes `search_tool_library("query")` to explicitly fetch the exact tool schema it requires from the database, preventing silent failures.

---

## 3. Unified Three-Tier Memory Architecture

To eliminate "catastrophic forgetting" and keep context usage tight, memory is distributed across three storage layers.

| Memory Tier | Storage Engine | Location | Lifetime | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **Short-Term Edge** | **IndexedDB** | In-Browser (Client) | Active Session | Stores raw DOM snapshots, screen coordinates, and the last 2–3 execution steps. |
| **Episodic Memory** | **Pinecone** | Serverless Vector DB | Persistent | Stores embedded step-by-step traces of past *successful* tasks for semantic retrieval. |
| **Long-Term Anchor** | **MongoDB / Neon** | Serverless Backend | Permanent | Stores user profiles, personalization rules, session IDs, and master system prompts. |

### Context Window Structure

```
┌────────────────────────────────────────────────────────────────────────┐
│ THE ANCHOR (Static - Top Pinned)                                       │
│ • System Prompt & Personalization Rules                                │
│ • User's Original Objective                                            │
│ • Qwen's High-Level Master Plan                                        │
├────────────────────────────────────────────────────────────────────────┤
│ THE MIDDLE (Compressed - Dynamic)                                      │
│ • Summarized log of completed steps (e.g., "Steps 1-4 completed")      │
│ • Relevant past task insights retrieved from Pinecone                  │
├────────────────────────────────────────────────────────────────────────┤
│ THE EDGE (Raw - Sliding Window)                                        │
│ • Raw outputs from last 2-3 execution turns                            │
│ • Immediate UI-TARS coordinates / Midscene DOM node state              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Infrastructure, Network & Out-of-Band Integration

### Reverse WebSocket Architecture (Zero-UX-Friction)
To run the heavy orchestrator on a backend server while executing Midscene.js locally inside the extension without forcing users to configure local IP ports or bridge settings:

1. **Client Connection:** The Chrome extension background script initiates an outbound WebSocket connection (`wss://api.follome.app/agent-session`) to Cloudflare Workers.
2. **Duplex Messaging:** The backend streams action commands down the socket (`{"action": "aiTap", "target": "Save button"}`).
3. **Local Execution:** The extension receives the message, executes Midscene.js / `chrome.debugger` locally within the browser, and returns the result back up the WebSocket.

### Hardening OpenRouter Pipelines
To prevent API throttling and maximize provider prompt caching:
* **Sticky Routing:** Every OpenRouter request includes an `x-session-id` HTTP header. This routes consecutive agent turns to the exact same provider node, achieving high prompt-cache hit rates for static system instructions.
* **Rate-Limit Backoff:** The OpenRouter client SDK is configured with exponential backoff:
```javascript
const client = new OpenRouter({
  apiKey: env.OPENROUTER_API_KEY,
  retryConfig: {
    strategy: "backoff",
    maxRetries: 5,
    initialIntervalMs: 1000,
    maxIntervalMs: 16000
  }
}); 

# ARCHITECTURAL AMENDMENT: Background Worker Isolation & Non-Interfering Tab Automation Pipeline

## 1. Executive Objective & Invariant Rules
The goal of this amendment is to decouple the **User’s Active Viewing Context** from the **AI Agent’s Execution Context**. 

* **The Master Invariant:** User tab switching, window focusing, or active typing in unrelated tabs (e.g., checking email, writing docs) MUST NEVER interfere with, hijack, or corrupt an ongoing AI task execution thread.
* **Target Isolation:** Every AI task thread is strictly bound to a designated `aiTabId`. All Chrome DevTools Protocol (CDP) commands, DOM extractions, and state changes must explicitly target `aiTabId` regardless of which tab is currently marked as `{ active: true }` in Chrome.

---

## 2. Technical Capabilities & Constraints Matrix (CDP in Background Tabs)

Because Chrome aggressively throttles GPU frame rendering on hidden/inactive tabs to conserve RAM and CPU, the pipeline enforces a strict capability boundary:

| Feature / Protocol Command | Inactive/Background Tab Status | Architectural Directives |
| :--- | :--- | :--- |
| `chrome.tabs.create({ active: false })` | **SUPPORTED** | Spawns silent background execution tabs without stealing user focus. |
| `chrome.debugger.attach({ tabId })` | **SUPPORTED** | CDP attaches cleanly to background tabs without bringing them to foreground. |
| `Accessibility.getFullAXTree` (CDP) | **SUPPORTED (100%)** | DOM Accessibility tree does NOT require GPU frame rendering. Extracts complete node trees on hidden tabs. |
| `Input.dispatchMouseEvent` (CDP) | **SUPPORTED (100%)** | Clicks nodes directly in the background tab without needing viewport visibility. |
| `Input.dispatchKeyEvent` (CDP) | **SUPPORTED (100%)** | Sends key events directly into DOM inputs on hidden tabs. |
| `Page.captureScreenshot` / `captureVisibleTab` | **THROTTLED / FAILS** | Returns blank, stale, or black frames if the tab is not physically painted on screen. |

---

## 3. Dual-Engine Background Execution Routing

To support silent, background automation while handling visual apps like Figma, the system executes tasks using a **DOM-First Background Strategy** with a **Foreground Escalation Protocol**.

```
                           ┌──────────────────────────────┐
                           │   AI Task Triggered by User  │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │ Spawn Inactive Background    │
                           │ Tab (active: false)          │
                           └──────────────┬───────────────┘
                                          │
                                          ▼
                           ┌──────────────────────────────┐
                           │ Target contains <canvas> or  │
                           │ requires raw Screenshot?     │
                           └──────┬────────────────┬──────┘
                                  │                │
                          NO (Standard Web)     YES (Figma / Visual)
                                  │                │
                                  ▼                ▼
┌───────────────────────────────────┐    ┌───────────────────────────────────┐
│ ENGINE A: DOM RELAY               │    │ FOREGROUND ESCALATION PROTOCOL    │
│ • Extract AXTree in Background    │    │ 1. Notify User / Request Focus    │
│ • GPT-4o Mini identifies Node ID  │    │ 2. Save currentUserTabId          │
│ • CDP dispatches Click via ID     │    │ 3. Briefly activate aiTabId       │
│ • Tab closes silently when done   │    │ 4. Capture & Execute UI-TARS      │
└───────────────────────────────────┘    │ 5. Instantly restore user Tab     │
                                         └───────────────────────────────────┘
```

### Engine A: Silent DOM Relay (Default for 90% of Tasks)
For YouTube, Google Docs, Gmail, job applications, research papers, and standard web apps:
1. **Creation:** Extension executes `chrome.tabs.create({ url: targetUrl, active: false })`.
2. **CDP Attachment:** `chrome.debugger.attach({ tabId: aiTabId }, "1.3")`.
3. **Extraction:** The worker requests `Accessibility.getFullAXTree` via CDP.
4. **Execution:** Midscene.js / GPT-4o Mini parses the Accessibility text tree, identifies the target `backendNodeId`, and dispatches simulated mouse/keyboard events via CDP directly to `aiTabId`.
5. **Teardown:** On task completion, `chrome.tabs.remove(aiTabId)` silently closes the tab, and a desktop notification (`chrome.notifications.create`) alerts the user: *"Task Complete: Video saved to Watch Later."*

### Engine B: Foreground Escalation Protocol (Canvas & Vision Fallback)
When interacting with HTML5 `<canvas>` elements (e.g., Figma wireframing) where no Accessibility DOM nodes exist and a viewport screenshot is strictly required:
1. **Detection:** The engine detects a `<canvas>` element or receives an `AXTreeEmpty` signal from Midscene.js.
2. **User Notification (Non-Intrusive):** Displays a non-modal chrome toast notification:
   > *"FolloMe needs focus for 3 seconds to complete the Figma canvas action."*
3. **State Freeze & Focus Switch:**
   ```javascript
   // Store current active user tab
   const [currentUserTab] = await chrome.tabs.query({ active: true, currentWindow: true });
   const currentUserTabId = currentUserTab.id;

   // Temporarily activate AI execution tab
   await chrome.tabs.update(aiTabId, { active: true });
   ```
4. **Visual Execution:** UI-TARS captures `Page.captureScreenshot`, calculates $(x, y)$ coordinates, and dispatches the native CDP click.
5. **Immediate Restoration:**
   ```javascript
   // Instantly restore user's original tab focus
   await chrome.tabs.update(currentUserTabId, { active: true });
   ```

---

## 4. State Isolation & Event Guardrails

To ensure active user browsing never pollutes background agent threads, you must enforce strict state scoping inside `background.js`.

### Rule 1: Scoped WebSocket Message Handler
Do NOT store global variables like `currentTab`. Every WebSocket payload and task loop must pass `aiTabId` explicitly in its payload context.

```javascript
// BAD (Global Leak)
let activeAutomationTabId = null;

// GOOD (Explicit Task Session Binding)
interface AgentTaskSession {
  sessionId: string;
  aiTabId: number;
  userOriginalTabId: number;
  engineMode: 'DOM_RELAY' | 'VISUAL_CANVAS';
}

const activeSessions = new Map<string, AgentTaskSession>();
```

### Rule 2: Explicit Event Listener Filtering
Ignore tab updates and active-tab changes for tabs that are not owned by the active AI session.

```javascript
chrome.tabs.onActivated.addListener((activeInfo) => {
  // User changed their active tab manually. 
  // DO NOT cancel or redirect any ongoing background AI session.
  console.log(`User moved to tab ${activeInfo.tabId}. AI tasks continue undisturbed.`);
});
```

---

## 5. Required Extension Manifest Permissions

Ensure your `manifest.json` contains the explicit permissions required to handle silent tab spawning, background debugging, and notifications:

```json
{
  "manifest_version": 3,
  "name": "FolloMe Background Agent Engine",
  "permissions": [
    "tabs",
    "debugger",
    "notifications",
    "activeTab",
    "scripting"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  }
}
```

---

## Summary Checklist for Implementation
1. **Use `active: false`** on all `chrome.tabs.create()` calls initiated by the AI agent.
2. **Never call `captureVisibleTab` or `Page.captureScreenshot`** on background tabs—route through Engine A (`Accessibility.getFullAXTree`) instead.
3. **Implement the Foreground Escalation Protocol** to briefly switch focus only when `<canvas>` elements require UI-TARS vision models.
4. **Bind `aiTabId` explicitly** to the `sessionId` state map to prevent user tab switching from interrupting the CDP messaging thread.

---
Powered by [AI Exporter](https://saveai.net)