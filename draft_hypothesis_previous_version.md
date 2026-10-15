# Draft Hypothesis: Previous Architecture

This document consolidates findings from three reports detailing the architecture and mechanisms of the previous version of the extension.

## 1. State Machine & Flow
The previous architecture relied on a state machine with strict states: `EVALUATE`, `SNAP`, `ACT`, `WAITING_FOR_DIFF`, and `REFLECT`. UI-TARS requests were mapped using strict XML pillars. The execution flow supported two distinct paths:
*   **Fast Path:** For quick, non-visual operations.
*   **Vision Path:** For operations requiring visual context and image processing.

## 2. Interaction & Content Script (`ai-content.js`)
*   **ChatGPT Stream Handling:** Instead of using a `MutationObserver`, the extension used a 500ms polling loop driven by the active tab to monitor ChatGPT streams.
*   **Text Input:** It utilized native prototype setters to bypass React's synthetic event system and directly type text into inputs.
*   **Image Attachment:** Images were attached using `DataTransfer`, with downscaling performed via a canvas element before attachment.

## 3. Orchestration & Tracking
*   **Coordinate Translation:** `Subphase3Orchestrator` was responsible for translating 1000x1000 UI-TARS coordinates to viewport coordinates using `innerWidth` and `innerHeight`.
*   **Visual Overlays:** The `action-listener.js` script drew green "TipTour" overlays to indicate UI interactions.
*   **Snapping Mechanism:** `SemanticSnapper` employed a 120px safety radius for snapping actions.
*   **DUD Detection:** The `rrweb-tracker` detected failed actions (DUDs) by checking the node count and URL 3 seconds after an action.
