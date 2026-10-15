# FolloMe Ghost UI v2.0 Architecture Plan

## Objective
Upgrade FolloMe to Ghost UI v2.0 to provide a seamless, conversational, and anonymous background pipeline without tab-switching. It involves STT on the target page, silent DOM/context transfer to ChatGPT, logic translation via Groq, and a multi-modal Ghost UI.

## Identified Discrepancies in Current Codebase
1. **Aggressive Tab Queries & Tab Switching in `service-worker.js`:**
   - In `SEND_TO_AI` (lines 711-721), the extension actively focuses or opens the AI tab using `chrome.tabs.create({ active: true })` and `chrome.tabs.update({ active: true })`. This breaks the anonymous background requirement.
   - In `RELAY_TO_TAB` (lines 790-793), it explicitly focuses the user's tab after getting a response.
2. **Current `overlay.js` Implementation:**
   - It contains a baseline `webkitSpeechRecognition` implementation, but it triggers the visible tab-switching pipeline.
   - `drawGhostUI` currently only renders a target ring, cursor, and a static "NEXT" button. It lacks the multi-modal rendering (Pointer Mode, Code Mode, Conversational Mode) and the interruption loop.

## Architecture Blocks

### Block 1: Speech-to-Text (STT) on Target Page
**Goal:** Capture user's voice directly on the target tab without navigating away.
**Files to Modify:** `content/overlay.js` (or a dedicated `content/speech.js`)
**Tasks:**
1. Enhance the existing `initVoiceRecognition()` in `overlay.js` to utilize the native `webkitSpeechRecognition` API comprehensively.
2. Alternatively, integrate Groq's Whisper API for faster/more accurate transcription by recording audio blobs and sending them to a background service worker handler.
3. Upon STT completion, capture the transcription and immediately bundle it with the DOM snapshot and screenshot.
4. Dispatch a background message (e.g., `SILENT_SEND_TO_AI`) instead of the legacy `FORWARD_TO_TEACHER` to avoid triggering tab switches.

### Block 2: Anonymous Background Context Transfer
**Goal:** Send STT transcript + DOM screenshot to ChatGPT and receive response silently.
**Files to Modify:** `background/service-worker.js`, `adapters/chatgpt-adapter.js` (or similar AI content script)
**Tasks:**
1. Create a hidden/background tab for ChatGPT using `chrome.tabs.create({ active: false })` or manage an existing inactive tab.
2. Update `SEND_TO_AI` handler in `service-worker.js` to prevent calling `chrome.tabs.update({ active: true })`. Ensure the AI tab is never focused.
3. Use `chrome.scripting.executeScript` or existing message passing to inject the STT query + DOM context into the ChatGPT DOM.
4. Trigger the ChatGPT send button programmatically.
5. Implement a `MutationObserver` in the AI content script (`ai-content.js` or `chatgpt-adapter.js`) to read the streaming/final response without user visibility.
6. Send the extracted chatty response back to `service-worker.js`.

### Block 3: The Groq Logic Translator
**Goal:** Convert ChatGPT's chatty response into strict JSON UI commands using Groq.
**Files to Modify:** `background/service-worker.js`, `brain/groq-mapper.js`
**Tasks:**
1. Intercept the chatty response in `service-worker.js` (from the `MutationObserver` background message).
2. Create a Groq API call targeting a fast text model (e.g., `llama3-8b-8192`).
3. Formulate a system prompt instructing Groq to act as a strict JSON logic router.
4. Groq must output JSON determining the mode:
   - `{"mode": "pointer", "element": "selector", "instruction": "..."}`
   - `{"mode": "code", "element": "selector", "instruction": "..."}`
   - `{"mode": "conversational", "options": ["Yes", "No", "Next"], "instruction": "..."}`
5. Pass this parsed JSON to the `RELAY_TO_TAB` function.

### Block 4: Ghost UI 2.0 (Front-End)
**Goal:** Render the parsed JSON into multi-modal UI elements and handle interruptions.
**Files to Modify:** `content/overlay.js`, `content/overlay.css`
**Tasks:**
1. Update `drawGhostUI` in `overlay.js` to parse the JSON modes.
2. **Pointer Mode:** Render the standard element highlighting and target ring.
3. **Code Mode:** Render transparent red/green bounding boxes around specified code/DOM elements.
4. **Conversational Mode:** Dynamically render "Yes", "No", and "Next" buttons instead of the static NEXT button.
5. **Loading State:** Replace generic spinners with contextual text like "Asking AI..." during the background processing.
6. **Interruption Loop:** Add an event listener to the "No, I didn't get this" (or "No") button. When clicked, capture a fresh screenshot + query and recursively trigger Block 2 without any visible tab switches.
