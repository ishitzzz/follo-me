# Project: FolloMe Integrated Pipeline

## Milestone 1: Architectural Restoration & Integration

### Feature 1.1: Restore the State Machine & HybridExecutor
- Description: Extract `service-worker.js` and `hybrid-executor.js` from `previous_version` and restore them as the core execution engine, removing the current standalone ReactAgent loop.
- Acceptance criteria: 
  - State machine runs the legacy EVALUATE -> SNAP -> ACT -> REFLECT loop.
  - HybridExecutor handles DOM and native CDP clicks with visual overlays.
- **Execution Method Evaluation:**
  - **Option A (Vanilla AI):** We use Vanilla AI to safely merge the old files into the current workspace without overwriting unrelated features.
  - **Selected Method:** Vanilla AI

### Feature 1.2: Upgrade the ChatGPT Event Listener
- Description: Replace the brittle 500ms polling loop in `ai-content.js` with a lightweight, throttle-proof Event Monitor architecture that won't freeze in Chrome background tabs.
- Acceptance criteria: 
  - Extension reliably detects ChatGPT messages immediately without freezing.
  - Safely injects text without breaking modern React/ProseMirror sites.
- **Execution Method Evaluation:**
  - **Option A (Vanilla AI):** Implement standard DOM MutationObservers and background Port messaging.
  - **Selected Method:** Vanilla AI

### Feature 1.3: Integrate ReactAgent as the Mediator Brain
- Description: Wire the ReactAgent strictly into the EVALUATE step of the restored state machine. It will understand ChatGPT intents, query UI-TARS, and pass exact coordinates to the HybridExecutor.
- Acceptance criteria: 
  - ReactAgent handles decision making but does not execute clicks natively.
  - If UI-TARS fails, ReactAgent reports back to ChatGPT autonomously.
- **Execution Method Evaluation:**
  - **Option A (Vanilla AI):** Modify the ReactAgent class to return structured coordinates instead of executing tools directly.
  - **Selected Method:** Vanilla AI
