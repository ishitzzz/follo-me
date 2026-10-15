# FolloMe — AI Architecture Guide

Welcome, Agent. This document maps out the FolloMe directory structure so you can easily understand where systems live and how they communicate.

## 📂 Directory Structure

### 1. Core Extension Logic
- **`background/`**: Contains the Service Worker (`service-worker.js`). This is the master orchestrator. It holds no real state itself, but routes messages between the DOM and the Offscreen Brain.
- **`brain/`**: The core AI and execution logic.
  - `session-manager.js`: Handles live memory state, committing `contextSnapshot` to `chrome.storage.local` to survive service worker suspensions (inspired by Lyto).
  - `offscreen.js`: The "Offscreen Brain" that stays permanently awake. It receives `EVALUATE_DOM` messages and handles all Groq/Llama LLM inference.
  - `hybrid-executor.js`: Executes the LLM's plan on the host page. Dynamically switches between standard DOM clicks and CDP (`chrome.debugger`) raw input clicks for canvas-heavy sites (inspired by TipTour).
  - `rrweb-tracker.js`: The mutation tracker injected via iframe to monitor page changes without blocking the main thread (inspired by MultiOn).
- **`content/`**: Code injected into the user's host page.
  - `content.js`: Injects the MultiOn-style iframes and triggers `DOM_EXTRACTED`.
- **`utils/`**: Helper logic.
  - `context-extractor.js`: Parses the DOM into an accessibility tree and detects canvas-heavy UI for the `HybridExecutor`.
- **`views/`**: Contains all HTML interfaces.
  - `chat_assistant.html`: The user-facing UI overlay injected into the host page.
  - `rrwebiframe.html`: The invisible mutation-tracking sandbox.
  - `offscreen.html`: The hidden background document holding the `offscreen.js` script.
  - `debug.html`: A developer trace tool for inspecting LLM memory states.

### 2. Configuration
- **`manifest.json`**: Standard MV3 manifest. Crucial permissions: `debugger` (for Hybrid Executor) and `offscreen` (for the Brain).
- **`config.js`**: Holds the `LLAMA_API_KEY`. (Make sure you don't commit it!).
- **`.env.example`**: Example template for `config.js`.

### 3. Documentation & References
- **`docs/architecture/`**: Contains all legacy and current markdown plans (e.g., `ARCHITECTURE_PROPOSAL.md`, `PHASE_1_DETAILED_PLAN.md`). Read these for historical context.
- **`reference_extensions/`**: Contains the raw, third-party source code for TipTour, MultiOn, and Lyto. You can use `grep` on these folders to study their exact algorithmic implementations.

## ⚙️ How the Unified Pipeline Works

1. **Boot**: The Service Worker wakes up, launches `SessionManager` (restoring memory from storage), and boots `views/offscreen.html`.
2. **Injection**: The user opens a tab. `content.js` injects `chat_assistant.html` and `rrwebiframe.html`.
3. **Extraction**: `content.js` calls `context-extractor.js`, builds the DOM tree, detects if the page is Canvas-heavy, and fires `DOM_EXTRACTED` to the Service Worker.
4. **Reasoning**: The Service Worker passes the DOM to the Offscreen Brain (`offscreen.js`), which asks the Llama LLM for a JSON action plan.
5. **Execution**: The Offscreen Brain returns the plan to the Service Worker, which invokes `hybrid-executor.js` to dispatch the click via DOM or `chrome.debugger` API.
