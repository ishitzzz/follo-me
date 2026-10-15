# Handoff: Feature 1.2 Fix 3
## Status: COMPLETE
## Files Changed
- followme-extension/brain/hybrid-executor.js (modified)
## Commands Executed
| Command | Exit Code | Notes |
|---------|-----------|-------|
| None | - | - |
## Unresolved Issues
- None
## Architectural Decisions
- Overrode `this.idlePromiseResolver` in `waitForNetworkIdle` to wrap both `clearTimeout(timer)` and `resolve()`. This ensures the timeout is cleared whenever the network successfully idles naturally (whether from incoming events stopping or other callers manually triggering idle), resolving the dangling timeout bug cleanly.
