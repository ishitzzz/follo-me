# Architecture Transition & Merger Hypothesis

## 1. The Legacy Pipeline
The legacy architecture relied on a robust, multi-layered synchronization model featuring a `GuidanceSession` and `SyncController` to prevent stale DOM execution. It featured:
*   **RecoveryEngine:** Provided semantic and structural fallbacks.
*   **HybridExecutor:** Managed clicks using either DOM clicks or native CDP clicks, accompanied by visual overlays.
*   **Service Worker:** Acted as a monolithic controller with a massive `executeStateMachine`, handling drawing overlays, retries, and the `GhostScout` orchestrator.
*   **Content Bridge:** Used coordinate-based payloads via `action-listener.js` with visual overlays.

## 2. The New Agentic Pipeline
The new architecture introduces a lightweight, agent-driven approach:
*   **ReactAgent:** Executes a thought-action-observation loop via an LLM. It truncates DOM state exceeding 300 elements. Note that tools such as Teacher AI and Vision are currently stubbed.
*   **Execution Paths:** Currently weak and brittle. It relies on a silent dud click check that uses strict HTML string matching and arbitrary 1.5s wait times, failing after 10 retries.
*   **Orchestration:** Uses a lightweight event dispatcher delegating entirely to `ReactAgent.js`. This resulted in the loss of the robust state machine execution mechanisms from the legacy pipeline.
*   **Content Bridge:** Employs DOM ID-based payloads via `content.js` without visual overlays.

## 3. What Broke During Transition
*   The robust state machine orchestration (`executeStateMachine`) was replaced by a naive event dispatcher, losing resilience and retry capabilities.
*   The weak execution paths in `ReactAgent` (arbitrary waits, strict string matching) lead to brittle click execution and frequent failures.
*   Visual feedback (overlays) for click execution was lost in the transition to DOM ID-based payloads.
*   DOM state truncation (>300 elements) limits the agent's ability to operate on complex pages.

## 4. Proposed Merger Strategy
*   **Hybrid Content Bridge:** Both `action-listener.js` and `content.js` scripts still exist and can coexist. We should restore visual overlays for DOM clicks.
*   **Unified Executor:** Implement a unified executor strategy for routing based on step requirements, combining the legacy coordinate-based approach and the new DOM ID-based approach.
*   **Restore Robust Orchestration:** Re-integrate the `RecoveryEngine` and state machine concepts from the legacy Service Worker to fortify the `ReactAgent`'s execution loop.
*   **Upgrade Execution Fallbacks:** Replace arbitrary waits and strict matching with the semantic and structural fallbacks provided by the legacy `RecoveryEngine`.
