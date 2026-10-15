/* TipTour Chrome Extension — Background Service Worker */

importScripts('./config.js', './recording-db.js', './recording-session.js', './tour-run-session.js', './cdp-driver.js');

const API_BASE = CONFIG.CONVEX_SITE_URL;
const RecordingSession = self.TipTourRecordingSession;
const TourRunSession = self.TipTourRunSession;
const CdpDriver = self.TipTourCdpDriver;

// Track which tabs have the content script injected
const injectedTabs = new Set();
const INJECTION_READY_ATTEMPTS = 12;
const INJECTION_READY_DELAY_MS = 150;

// ─── Side Panel: open on toolbar-icon click ─────────────────
//
// Replaces the old default_popup behaviour. With this set, clicking
// the extension icon opens the persistent side panel directly — same
// pattern Claude's extension uses. Set inside an install + startup
// listener so the behaviour applies in both new-install and
// service-worker-cold-start cases.
function configureSidePanel() {
  if (!chrome.sidePanel) return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[TipTour] sidePanel.setPanelBehavior:', err));
}
configureSidePanel();
chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);

async function getStoredExtensionToken() {
  const stored = await chrome.storage.local.get('tiptour-extension-token');
  return typeof stored['tiptour-extension-token'] === 'string'
    ? stored['tiptour-extension-token'].trim()
    : '';
}

async function forwardTelemetry(msg) {
  const extensionToken = await getStoredExtensionToken();
  await fetch(msg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(extensionToken ? { 'X-TipTour-Extension-Token': extensionToken } : {}),
    },
    body: JSON.stringify({ events: msg.events }),
    keepalive: true,
  });
}

function resolveMessageTabId(msg, sender) {
  if (Number.isInteger(msg.tabId)) return msg.tabId;
  if (Number.isInteger(sender.tab?.id)) return sender.tab.id;
  return null;
}

function handleCdpMessage(msg, sender) {
  const tabId = resolveMessageTabId(msg, sender);
  if (!tabId) return Promise.resolve({ ok: false, error: 'No tab id for CDP command.' });

  switch (msg.type) {
    case 'cdp:attach':
      return CdpDriver.attach(tabId);
    case 'cdp:detach':
      return CdpDriver.detach(tabId);
    case 'cdp:health':
      return CdpDriver.health(tabId);
    case 'cdp:drain-events':
      return Promise.resolve(CdpDriver.drainEvents(tabId));
    case 'cdp:wait-for-network-idle':
      return CdpDriver.waitForNetworkIdle(tabId, msg.options || {});
    case 'cdp:handle-dialog':
      return CdpDriver.handleDialog(tabId, msg.options || {});
    case 'cdp:screenshot':
      return CdpDriver.screenshot(tabId, msg.options || {});
    case 'cdp:snapshot':
      return CdpDriver.getSnapshot(tabId);
    case 'cdp:click-at':
      return CdpDriver.clickAt(tabId, Number(msg.x), Number(msg.y), msg.options || {});
    case 'cdp:click-selector':
      return CdpDriver.clickSelector(tabId, String(msg.selector || ''));
    case 'cdp:capture-target-at':
      return CdpDriver.captureTargetAt(tabId, Number(msg.x), Number(msg.y));
    case 'cdp:resolve-target':
      return CdpDriver.resolveTarget(tabId, msg.target);
    case 'cdp:fill-at':
      return CdpDriver.fillAt(tabId, Number(msg.x), Number(msg.y), String(msg.text || ''));
    case 'cdp:check-at':
      return CdpDriver.checkAt(tabId, Number(msg.x), Number(msg.y), msg.checked);
    case 'cdp:select-at':
      return CdpDriver.selectAt(tabId, Number(msg.x), Number(msg.y), String(msg.option || ''));
    case 'cdp:type-text':
      return CdpDriver.typeText(tabId, String(msg.text || ''));
    case 'cdp:press-key':
      return CdpDriver.pressKey(tabId, String(msg.combo || ''));
    default:
      return Promise.resolve({ ok: false, error: `Unknown CDP command: ${msg.type}` });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function clearStaleEmbedState(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.TipTour) return;
      try { delete window.__tiptourEmbed; } catch {}
      document.documentElement.removeAttribute('data-tiptour-loaded');
    },
  });
}

async function waitForTipTourReady(tabId) {
  let lastResponse = null;
  for (let attempt = 0; attempt < INJECTION_READY_ATTEMPTS; attempt++) {
    const response = await sendTabMessage(tabId, { type: 'ping' });
    lastResponse = response;
    if (response?.ok && response.tipTour === true) return response;
    await sleep(INJECTION_READY_DELAY_MS);
  }
  return {
    ok: false,
    error: 'TipTour content shell loaded, but the embed API did not become ready.',
    status: lastResponse,
  };
}

async function showAgentInTab(tabId, messageType) {
  const injected = await handleInject(tabId);
  if (!injected?.ok) return injected;

  let response = await sendTabMessage(tabId, { type: messageType });
  if (response?.ok) return response;

  const reinjected = await handleInject(tabId, { force: true });
  if (!reinjected?.ok) return reinjected;
  response = await sendTabMessage(tabId, { type: messageType });
  return response?.ok
    ? response
    : { ok: false, error: response?.error || `Failed to send ${messageType}.`, status: response?.status };
}

// ─── Keyboard Shortcut → Agent Mode ─────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || tab.url.startsWith('chrome://')) return;

  if (command === 'open-agent') {
    // Text-input shortcut. ⌘K (Mac) / Ctrl+K. Injects embed if not
    // already there, then asks it to show the cursor + open prompt
    // bar. Page-level handlers can't intercept — Chrome dispatches
    // commands at the OS level above page keyboard listeners.
    const response = await showAgentInTab(tab.id, 'agent-show');
    if (!response?.ok) console.warn('[TipTour] open-agent failed:', response);
    return;
  }

  if (command === 'open-voice') {
    // Voice-mode shortcut. ⌘+Shift+K (Mac) / Ctrl+Shift+K. Same
    // injection-then-message pattern — relay 'toggle-voice' to the
    // content-shell which calls tiptour('voice').
    //
    // Note: ⌘+/ is also a page-level shortcut (when embed is loaded
    // and the host page doesn't intercept it). This Chrome-level
    // command is the "always works first-press" entry, since some
    // sites (IRCTC, Google docs) trap Cmd+/ before our document
    // listener gets it.
    const response = await showAgentInTab(tab.id, 'toggle-voice');
    if (!response?.ok) console.warn('[TipTour] open-voice failed:', response);
    return;
  }
});

// ─── Message Handler (one-shot messages) ─────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (typeof msg.type === 'string' && msg.type.startsWith('cdp:')) {
    handleCdpMessage(msg, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === 'tiptour-telemetry') {
    // Telemetry POST forwarded from the embed running in a content
    // script. We do the fetch here in the background service worker
    // because some customer sites (e.g. irctc.co.in) have their own
    // page-level service worker that intercepts every cross-origin
    // fetch and 504s. The extension's background runs in its own
    // origin and isn't subject to the page's SW — fetches from here
    // go straight to the network.
    forwardTelemetry(msg).catch((caughtError) => {
      console.warn('[tiptour] telemetry forward failed:', caughtError);
    });
    // No response needed — telemetry is fire-and-forget. Returning
    // false (the default) ends the message channel synchronously.
    return false;
  }

  if (msg.type === 'generate') {
    handleGenerate(msg.url).then(sendResponse);
    return true;
  }

  if (msg.type === 'inject') {
    handleInject(msg.tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'start-recording') {
    handleStartRecording(msg.tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'recording-complete') {
    handleRecordingComplete(msg.data).then(sendResponse);
    return true;
  }

  if (msg.type === 'tour-run:save') {
    TourRunSession.saveFromContent(msg.state, sender.tab)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === 'tour-run:read') {
    TourRunSession.getForTab(sender.tab?.id)
      .then((run) => sendResponse({ run }))
      .catch(() => sendResponse({ run: null }));
    return true;
  }

  if (msg.type === 'tour-run:clear') {
    clearTourRunFromContent(sender.tab, msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === 'recorder:get-active-draft') {
    RecordingSession.getActive().then((recording) => {
      const senderTabId = sender.tab?.id;
      if (
        recording &&
        typeof senderTabId === 'number' &&
        typeof recording.tabId === 'number' &&
        recording.tabId !== senderTabId
      ) {
        sendResponse({ recording: null });
        return;
      }
      sendResponse({ recording });
    });
    return true;
  }

  if (msg.type === 'recorder:draft-updated') {
    RecordingSession.updateActiveDraft(msg.data, sender.tab?.id).then(sendResponse);
    return true;
  }

  if (msg.type === 'recorder:draft-discarded') {
    RecordingSession.clearActive()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  // ─── Side panel ↔ recorder bridge ─────────────────────────
  //
  // The side panel runs in the extension's own runtime, the recorder
  // runs as a content script on the customer's tab. They can't talk
  // directly — every message hops through here. The panel sends
  // `panel:*` messages; we look up the active recording tab and
  // forward as `recorder:*` to that tab. The recorder broadcasts
  // `recorder:*` events back via chrome.runtime.sendMessage, which
  // the panel picks up directly (the broadcasts pass through this
  // listener too, but we ignore them — fall-through is fine).

  if (msg.type === 'panel:start-recording') {
    handleStartRecording(msg.tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'panel:stop-recording') {
    forwardToRecorderTab({
      type: 'stop-recording',
      requestedSlug: typeof msg.requestedSlug === 'string' ? msg.requestedSlug : '',
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'panel:discard-recording') {
    forwardToRecorderTab({ type: 'discard-recording' }).then(sendResponse);
    return true;
  }

  if (msg.type === 'panel:delete-step') {
    forwardToRecorderTab({
      type: 'recorder:delete-step',
      stepId: msg.stepId,
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'panel:toggle-pause') {
    forwardToRecorderTab({ type: 'recorder:toggle-pause' }).then(sendResponse);
    return true;
  }

  if (msg.type === 'panel:update-recording-meta') {
    RecordingSession.updateActiveMetadata({
      requestedSlug: typeof msg.requestedSlug === 'string' ? msg.requestedSlug : '',
    }).then(sendResponse);
    return true;
  }

  if (msg.type === 'panel:get-state') {
    RecordingSession.getActive().then((recording) => {
      sendResponse({ recording });
    });
    return true;
  }

  if (msg.type === 'panel:start-tour') {
    handleStartTour(msg.tabId, msg.workflowId, { autoRun: msg.autoRun === true }).then(sendResponse);
    return true;
  }

  /*
   * Visual context capture for the agent.
   *
   * When the embed (running as a content script) is about to send a
   * chat message and the user has visual context enabled, it asks the
   * background for a screenshot of the current viewport. We use
   * chrome.tabs.captureVisibleTab — pixel-perfect including iframes,
   * video, and canvas. Only available in the extension, not the
   * embed-script build.
   *
   * Privacy: respects the `tiptour-visual-context` chrome.storage flag
   * (default on). User can flip it off in the popup at any time and
   * captures stop immediately.
   */
  if (msg.type === 'tiptour:capture-screen') {
    chrome.storage.local.get('tiptour-visual-context', (stored) => {
      const enabled = stored['tiptour-visual-context'] !== false;
      const isRecorderThumbnail = msg.reason === 'recorder-thumbnail';
      if (!enabled && !isRecorderThumbnail) {
        sendResponse({ disabled: true });
        return;
      }

      const tabId = sender.tab?.id;
      const windowId = sender.tab?.windowId;
      if (typeof windowId !== 'number') {
        sendResponse({ error: 'no window' });
        return;
      }

      try {
        chrome.tabs.captureVisibleTab(
          windowId,
          { format: 'jpeg', quality: 70 },
          (dataUrl) => {
            if (chrome.runtime.lastError) {
              const message = chrome.runtime.lastError.message || 'capture failed';
              sendResponse({
                error: message,
                needsPermission:
                  message.includes("'<all_urls>'") ||
                  message.includes('activeTab') ||
                  message.toLowerCase().includes('permission'),
              });
              return;
            }
            sendResponse({ dataUrl, tabId });
          }
        );
      } catch (err) {
        sendResponse({ error: err?.message || String(err) });
      }
    });
    return true;
  }
});

chrome.runtime.onMessageExternal?.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'tiptour:connect-extension') return false;
  const token = typeof msg.token === 'string' ? msg.token.trim() : '';
  if (!token) {
    sendResponse({ ok: false, error: 'Missing extension token.' });
    return false;
  }
  chrome.storage.local.set({ 'tiptour-extension-token': token }).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: err?.message || 'Could not save token.' })
  );
  return true;
});

// ─── Port Handler (streaming messages) ───────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'generate-stream') {
    port.onMessage.addListener((msg) => {
      handleGenerateStream(port, msg.url);
    });
  }

  if (port.name === 'refine') {
    port.onMessage.addListener((msg) => {
      handleRefine(port, msg.config, msg.instruction);
    });
  }

  // agent-chat is now handled directly by embed.js — no port needed
});

// ─── Streaming Generate ──────────────────────────────────────

async function handleGenerateStream(port, url) {
  try {
    const res = await fetch(`${API_BASE}/generate-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Generation failed' }));
      port.postMessage({ type: 'error', message: data.error || 'Generation failed' });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'done') {
            port.postMessage({ type: 'done' });
          } else if (msg.type === 'error') {
            port.postMessage({ type: 'error', message: msg.message });
          } else if (msg.type === 'stage') {
            port.postMessage({ type: 'stage', stage: msg.stage });
          } else {
            port.postMessage({ type: 'patch', op: msg });
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    if (buffer.trim()) {
      try {
        const msg = JSON.parse(buffer);
        if (msg.type === 'done') {
          port.postMessage({ type: 'done' });
        } else if (msg.op) {
          port.postMessage({ type: 'patch', op: msg });
        }
      } catch {}
    }
  } catch (err) {
    const message = err.name === 'TimeoutError'
      ? 'Request timed out — try a simpler page.'
      : 'Network error — could not reach the TipTour server.';
    port.postMessage({ type: 'error', message });
  }
}

// ─── Refine ──────────────────────────────────────────────────

async function handleRefine(port, config, instruction) {
  try {
    const res = await fetch(`${API_BASE}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, instruction }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Refinement failed' }));
      port.postMessage({ type: 'error', message: data.error || 'Refinement failed' });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'done') {
            port.postMessage({ type: 'done' });
          } else if (msg.type === 'error') {
            port.postMessage({ type: 'error', message: msg.message });
          } else {
            port.postMessage({ type: 'patch', op: msg });
          }
        } catch {}
      }
    }
  } catch (err) {
    port.postMessage({ type: 'error', message: 'Refinement failed: ' + err.message });
  }
}

// ─── Legacy Generate ─────────────────────────────────────────

async function handleGenerate(url) {
  try {
    const res = await fetch(`${API_BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(90000),
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Generation failed' };
    return { data };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { error: 'Request timed out — try a simpler page.' };
    }
    return { error: 'Network error — could not reach the TipTour server.' };
  }
}

// ─── Inject Content Script ───────────────────────────────────

async function handleInject(tabId, options = {}) {
  if (injectedTabs.has(tabId) && options.force !== true) {
    const ping = await sendTabMessage(tabId, { type: 'ping' });
    if (ping?.ok && ping.tipTour === true) return { ok: true, status: ping };
    if (ping?.ok) {
      await sendTabMessage(tabId, { type: 'tiptour-reset-stale' });
    } else {
      injectedTabs.delete(tabId);
    }
  }

  try {
    await clearStaleEmbedState(tabId);
    // Inject embed.js (full TipTour library + agent + page tools)
    // then content-shell.js (thin bridge for Chrome extension messages)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['embed.js', 'content-shell.js']
    });

    injectedTabs.add(tabId);
    const ready = await waitForTipTourReady(tabId);
    if (ready?.ok) return { ok: true, status: ready };
    return ready;
  } catch (err) {
    return { ok: false, error: 'Failed to inject: ' + (err?.message || String(err)) };
  }
}

// ─── Recording ───────────────────────────────────────────────

// Note: we don't cache "this tab has the recorder script" anymore.
// chrome.scripting.executeScript is cheap, idempotent at the bundle
// level, and the recorder.js itself guards against double-init via
// a window-scoped sentinel. Caching here used to silently skip
// injection after a page navigation killed the previous content
// script, leaving the recorder dead — symptom: clicking around does
// nothing because the message listener was never re-registered.

/**
 * Find the tab the recorder is currently active on and forward a
 * message to it. Used by the side-panel bridge so the panel can
 * pause / delete-step / stop without knowing which tab carries the
 * recording. Returns { ok: true } on success, { ok: false } if no
 * recording is in progress.
 *
 * Reads the lightweight active draft pointer from chrome.storage.session.
 * The bulky recording data lives in extension-owned IndexedDB; session
 * storage only tells us which tab and draft are currently active.
 */
async function forwardToRecorderTab(message) {
  const recordingState = await RecordingSession.getPointer();
  if (!recordingState || typeof recordingState.tabId !== 'number') {
    return { ok: false, error: 'No recording in progress.' };
  }
  try {
    const response = await chrome.tabs.sendMessage(recordingState.tabId, message);
    if (message.type === 'discard-recording' && (!response || response.ok !== false)) {
      await RecordingSession.clearActive();
    }
    return response || { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

async function handleStartRecording(tabId) {
  console.log('[TipTour BG] handleStartRecording for tab', tabId);
  let draftPointer = null;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    draftPointer = await RecordingSession.createDraftForTab(tabId, tab?.url || '');
    // Always inject. recorder.js's window.__tiptourRecorderInited
    // sentinel makes the second run a no-op when the script is still
    // alive on the tab — and when it ISN'T (post-navigation), we
    // need the fresh injection.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['recorder.js'],
    });

    await RecordingSession.activateDraft(draftPointer);
    await chrome.tabs.sendMessage(tabId, {
      type: 'start-recording',
      draftId: draftPointer.draftId,
      existingSteps: [],
    });
    console.log('[TipTour BG] start-recording dispatched to tab', tabId);
    return { ok: true, draftId: draftPointer.draftId };
  } catch (err) {
    if (draftPointer?.draftId) {
      await RecordingSession.clearDraftIfActive(draftPointer.draftId).catch(() => {});
    }
    console.error('[TipTour BG] handleStartRecording failed:', err);
    return { ok: false, error: 'Failed to start recording: ' + err.message };
  }
}

async function handleStartTour(tabId, workflowId, options = {}) {
  if (!tabId || !workflowId) return { ok: false, error: 'Missing tab or workflow.' };
  try {
    const extensionToken = await getStoredExtensionToken();
    const response = await fetch(
      `${CONFIG.CONVEX_SITE_URL}/workflows/by-id?id=${encodeURIComponent(workflowId)}`,
      {
        headers: extensionToken ? { 'X-TipTour-Extension-Token': extensionToken } : {},
      }
    );
    if (!response.ok) return { ok: false, error: `Workflow fetch failed: ${response.status}` };

    const config = await response.json();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const injected = await handleInject(tabId);
    if (injected?.error) return { ok: false, error: injected.error };

    await TourRunSession.startForTab(tab || { id: tabId }, config, {
      autoRun: options.autoRun === true,
    });
    try {
      const startResponse = await chrome.tabs.sendMessage(tabId, {
        type: 'start-tour',
        config,
        autoRun: options.autoRun === true,
      });
      return startResponse || { ok: true };
    } catch (err) {
      await TourRunSession.clearForTab(tabId);
      throw err;
    }
  } catch (err) {
    return { ok: false, error: 'Failed to start tour: ' + (err?.message || String(err)) };
  }
}

async function clearTourRunFromContent(tab, msg) {
  const tabId = tab?.id;
  const senderUrl = typeof msg?.currentUrl === 'string' ? msg.currentUrl : '';
  const tabUrl = typeof tab?.url === 'string' ? tab.url : '';
  const activeRun = await TourRunSession.getForTab(tabId);

  // Page contexts are disposable. During a navigation, the old document can
  // still finish async cleanup after Chrome has already moved the tab to the
  // next URL. Do not let that stale context clear the durable background run
  // before the newly-injected page has a chance to resume it.
  if (senderUrl && tabUrl && senderUrl !== tabUrl) {
    return { ok: true, ignored: 'stale-document' };
  }
  if (activeRun?.autoRun && isAutoRunNavigationBridgeClear(activeRun, senderUrl)) {
    return { ok: true, ignored: 'auto-run-navigation-bridge' };
  }

  return TourRunSession.clearForTab(tabId);
}

function isAutoRunNavigationBridgeClear(run, senderUrl) {
  const step = run?.config?.steps?.[run.currentStepId];
  if (!step || step.action?.type !== 'click') return false;
  const transitions = Array.isArray(step.transitions) ? step.transitions : [];
  const nextStepId = transitions[0]?.to || step.defaultNext;
  if (!nextStepId) return false;
  const nextStep = run.config?.steps?.[nextStepId];
  const nextUrl = typeof nextStep?.expectedUrl === 'string' ? nextStep.expectedUrl : '';
  if (!nextUrl || !senderUrl) return false;
  return !matchesBackgroundUrlPattern(nextUrl, senderUrl);
}

function matchesBackgroundUrlPattern(pattern, url) {
  if (!pattern) return true;
  const escaped = pattern
    .replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(url);
  } catch {
    return false;
  }
}

async function handleRecordingComplete(data) {
  // Build a minimal WorkflowConfig from the captured steps. Title is
  // a placeholder — user names it in the admin /tours/[id] page after
  // we open it. The recorded steps are wired linearly (recorder.js
  // already set transitions), domain comes from the tiptour-site-id-
  // override or hostname (recorder.js stopRecording).
  const activeRecording = await RecordingSession.getActive();
  const draftId = data?.draftId || activeRecording?.draftId || null;
  const stepsArray = Array.isArray(data?.steps) && data.steps.length > 0
    ? data.steps
    : (Array.isArray(activeRecording?.steps) ? activeRecording.steps : []);
  if (stepsArray.length === 0) {
    return { ok: false, error: 'No steps captured.' };
  }
  const stepsMap = {};
  for (const step of stepsArray) {
    stepsMap[step.id] = normalizeRecordedStepForReplay(step);
  }
  const recordedDomain = data?.domain || activeRecording?.domain || 'unknown';
  const requestedSlug = sanitizeWorkflowSlug(data?.requestedSlug || activeRecording?.requestedSlug || '');
  const generatedId = `recorded-${recordedDomain}-${Date.now()}`;
  const workflowId = requestedSlug || generatedId;
  const workflowTitle = requestedSlug
    ? titleFromWorkflowSlug(requestedSlug)
    : `Recording on ${recordedDomain}`;
  const config = {
    id: workflowId,
    title: workflowTitle,
    description: '',
    domain: recordedDomain,
    entryStep: stepsArray[0].id,
    steps: stepsMap,
    metadata: {
      source: 'recorder',
      recordedAt: data?.recordedAt || Date.now(),
      url: data?.url || activeRecording?.url || '',
      draftId,
      requestedSlug: requestedSlug || undefined,
    },
  };
  const semanticPlan = buildRecordingSemanticPlan({
    config,
    steps: stepsArray,
    stepCapture: buildStepCapturePresence(stepsArray),
    url: data?.url || activeRecording?.url || '',
    domain: recordedDomain,
  });

  // Publish straight to Convex as a draft (active=false). Admin app
  // /tours/[id] page already supports editing drafts — re-uses the
  // same UI a customer would see when picking up where they left off.
  try {
    const extensionToken = await getStoredExtensionToken();
    const response = await fetch(`${CONFIG.CONVEX_SITE_URL}/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(extensionToken
          ? { 'X-TipTour-Extension-Token': extensionToken }
          : { Authorization: `Bearer ${CONFIG.TIPTOUR_API_KEY}` }),
      },
      // active: false → land as draft. User publishes from the admin
      // /tours/[id] page after reviewing + naming.
      body: JSON.stringify({ config, semanticPlan, active: false }),
    });
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      return {
        ok: false,
        error: `Couldn't publish: ${errBody.error || response.status}`,
      };
    }
    const result = await response.json();
    await RecordingSession.clearActive();
    // result has { id (Convex doc ID), workflowId }. Open the admin
    // tour-detail page in a new tab so the user names + reviews +
    // publishes the tour using the existing UI. Falls back to /tours
    // listing if either ID is missing (shouldn't happen).
    const adminPath = result.id
      ? `/tours/${encodeURIComponent(result.id)}`
      : '/tours';
    await chrome.tabs.create({
      url: `${CONFIG.ADMIN_APP_URL}${adminPath}`,
    });
    return {
      ok: true,
      id: result.id || null,
      workflowId: result.workflowId || null,
      adminUrl: `${CONFIG.ADMIN_APP_URL}${adminPath}`,
    };
  } catch (err) {
    return { ok: false, error: 'Network error: ' + (err && err.message) };
  }
}

function sanitizeWorkflowSlug(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function titleFromWorkflowSlug(slug) {
  const words = sanitizeWorkflowSlug(slug)
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(' ') : slug;
}

function buildRecordingSemanticPlan({ config, steps, stepCapture, url, domain }) {
  const instructions = [];
  const orderedSteps = Array.isArray(steps) ? steps : [];

  for (const step of orderedSteps) {
    if (!step || typeof step !== 'object') continue;
    const instruction = semanticInstructionForStep(step);
    if (!instruction) continue;
    instructions.push(instruction);
  }

  if (instructions.length === 0) return undefined;

  return {
    text: buildSemanticRecipeText({
      title: config.description || config.title || `Complete the recorded workflow on ${domain || 'this app'}`,
      instructions,
      url,
      domain,
    }),
    ...(url ? { startUrl: url } : {}),
  };
}

function buildStepCapturePresence(steps) {
  const result = {};
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step?.id) continue;
    if (step.thumbDataUrl || step.clickPoint || step.viewportSize) {
      result[step.id] = true;
    }
  }
  return result;
}

function semanticInstructionForStep(step) {
  const content = compactSemanticText(step.content, 180);
  if (content) return content;
  const targetName = semanticTargetName(step);
  const actionType = step.action?.type || 'interact';
  switch (actionType) {
    case 'click': return `Click ${targetName}.`;
    case 'fill': return `Enter the requested value in ${targetName}.`;
    case 'select': return `Choose the requested option from ${targetName}.`;
    case 'check': return `Set ${targetName}.`;
    default: return `Interact with ${targetName}.`;
  }
}

function buildSemanticRecipeText({ title, instructions, url, domain }) {
  const lines = [];
  if (url) {
    lines.push(`On the page (${url}):`, '');
  } else {
    lines.push(`${compactSemanticText(title, 220)}.`, '');
  }
  instructions.forEach((instruction, index) => {
    lines.push(`${index + 1}. ${instruction}`);
  });
  lines.push('', `The workflow is complete after the final recorded step on ${domain || 'the app'}.`);
  return compactSemanticBlock(lines.join('\n'), 8000);
}

function semanticTargetName(step) {
  const target = step?.target || {};
  const label =
    target.text ||
    target.ref ||
    target.selector ||
    step.title ||
    'the highlighted control';
  return `"${compactSemanticText(label, 70) || 'the highlighted control'}"`;
}

function compactSemanticText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) return '';
  return compacted.length > maxLength
    ? compacted.slice(0, maxLength - 1).trimEnd() + '…'
    : compacted;
}

function compactSemanticBlock(value, maxLength) {
  if (typeof value !== 'string') return '';
  const compacted = value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!compacted) return '';
  return compacted.length > maxLength
    ? compacted.slice(0, maxLength - 1).trimEnd() + '…'
    : compacted;
}

function normalizeRecordedStepForReplay(step) {
  if (!step || typeof step !== 'object') return step;
  if (!step.action || typeof step.action !== 'object') return step;
  const actionType = step.action.type;
  if (actionType !== 'fill' && actionType !== 'select') return step;
  const action = { ...step.action };
  // Recorded tours are instructions, not form replays. Do not make
  // future users type/select the exact private value captured during
  // recording; any non-empty input/change should advance the step.
  delete action.value;
  delete action.option;
  return { ...step, action };
}

// ─── Multi-Page Recording ────────────────────────────────────

// Re-inject the recorder *and* the embed on every full page load. Without
// this, the embed runs only on the page where the user first invoked it
// — the moment a tour or chat-driven highlight triggers a navigation,
// the engine context dies and any pending continuation has nobody to
// read it. We track which tabs have ever had the embed
// (via `injectedTabs`) so we don't blast it onto random tabs the user
// never opted in to.
chrome.webNavigation?.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await reinjectRecorderIfNeeded(details.tabId);
  await reinjectEmbedIfNeeded(details.tabId);
});

// Same for SPA history transitions (pushState / replaceState). The
// page itself doesn't reload but the URL changed; the embed's
// continuation-resume logic still wants to fire on the new URL so any
// pending sessionStorage continuation keeps the conversation going.
chrome.webNavigation?.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await reinjectRecorderIfNeeded(details.tabId);
  await reinjectEmbedIfNeeded(details.tabId);
});

// If a tour click opens a new tab/window, move the active run to the
// newly-created tab before its content script boots. This mirrors how
// browser automation controllers follow popup targets instead of leaving
// the session stranded on the opener page.
chrome.webNavigation?.onCreatedNavigationTarget?.addListener(async (details) => {
  if (typeof details.sourceTabId !== 'number') return;
  const targetTab = await chrome.tabs.get(details.tabId).catch(() => ({
    id: details.tabId,
    windowId: details.windowId,
    url: details.url || '',
  }));
  const handoff = await TourRunSession.transferToTab(details.sourceTabId, targetTab);
  if (handoff?.ok) {
    await reinjectEmbedIfNeeded(details.tabId);
  }
});

async function reinjectRecorderIfNeeded(tabId) {
  const recordingState = await RecordingSession.getPointer();
  if (!recordingState || recordingState.tabId !== tabId) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['recorder.js']
    });
  } catch (err) {
    console.error('[TipTour] Failed to re-inject recorder after navigation:', err);
  }
}

async function reinjectEmbedIfNeeded(tabId) {
  // Auto-inject the embed on EVERY page load so its keyboard
  // listeners (⌘K text, ⌘+/ voice) are immediately live. Without
  // this, ⌘+/ on a fresh tab does nothing because no listener
  // exists yet — the user had to ⌘K first to force injection,
  // then ⌘+/ to switch to voice. Lazy-loading the embed was
  // privacy-conservative but a worse UX.
  //
  // The embed's own boot logic in src/embed/embed.ts gates cursor
  // visibility on `inExtensionContext` + pending continuation/tour,
  // so a user who never invokes the agent on a page sees no UI.
  // Listeners are passive (no network, no DOM mutation) until a
  // shortcut fires. Net cost: ~140KB JS per page (cached).
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;
    // Skip URLs we can never inject into (chrome://, web-store).
    if (
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('https://chromewebstore.google.com')
    ) {
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['embed.js', 'content-shell.js']
    });
    injectedTabs.add(tabId);
  } catch (err) {
    // Common on cross-origin iframes / restricted pages — fail
    // silently so we don't spam the console.
    void err;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  CdpDriver.detach(tabId).catch(() => {});
  TourRunSession.clearForTab(tabId).catch(() => {});
});
