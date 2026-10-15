# Validation Contract

## Milestone 1: Architectural Restoration & Integration

### Feature 1.1: Restore the State Machine & HybridExecutor
- [ ] Assertion: `service-worker.js` handles `START_AGENT_PIPELINE` via the legacy `executeStateMachine` loop and does not call `agent.start()`.
- [ ] Assertion: `HybridExecutor` receives specific X/Y coordinates and successfully initiates a `DRAW_TIPTOUR_OVERLAY` before dispatching a click.
- [ ] Edge case: Calling a nonexistent method on the executor gracefully escalates the state machine to the REFLECT state without crashing the service worker.

### Feature 1.2: Upgrade the ChatGPT Event Listener
- [ ] Assertion: `ai-content.js` does NOT use `setInterval` for polling the LLM stream.
- [ ] Assertion: The background script correctly receives `TEACHER_RESPONSE` messages immediately when text stabilizes on the screen.
- [ ] Edge case: If the LLM generates a very long response that pauses midway, the listener does not trigger prematurely before the stream completes.

### Feature 1.3: Integrate ReactAgent as the Mediator Brain
- [ ] Assertion: `ReactAgent` outputs explicit X/Y coordinates to the orchestrator instead of attempting to execute `click_element` directly.
- [ ] Assertion: If UI-TARS returns a hallucinated coordinate (no interactive element at that pixel), `SemanticSnapper` detects it and triggers the `HALLUCINATION` error path back to the ReactAgent.
- [ ] Edge case: If UI-TARS is offline or times out, the ReactAgent correctly falls back to communicating the exact error string back to the ChatGPT tab.
