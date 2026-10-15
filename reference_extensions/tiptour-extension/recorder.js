/**
 * TipTour Workflow Recorder
 *
 * Injected into the page when recording starts. Captures clicks /
 * fills / selects as WorkflowSteps with real selectors. The actual
 * UI (timeline + controls) lives in the side panel; this script's
 * only job is to listen on the page and broadcast captured steps
 * back to the panel via chrome.runtime.sendMessage.
 *
 * Init guard: chrome.scripting.executeScript may run this file more
 * than once on a tab (each "Record" press triggers a re-inject). We
 * stash a sentinel on the isolated-world window so the second run is
 * a no-op — without it, click listeners would stack and capture each
 * click N times. We use a labeled IIFE so the early-out lands inside
 * a function, not at the script-top-level (Chrome content scripts
 * don't allow a top-level `return`).
 */

/* global TipTourLib */

(function tiptourRecorderInit() {
  if (window.__tiptourRecorderInited) {
    console.log('[TipTour Recorder] Already initialised — skipping re-init.');
    return;
  }
  window.__tiptourRecorderInited = true;
  console.log('[TipTour Recorder] Initialising on', window.location.href);

// ─── State ───────────────────────────────────────────────────────

let recording = false
let paused = false
let steps = []
// Legacy in-page control bar — kept as null after the side-panel
// redesign. The variable still exists because handleClick filters
// clicks inside it; with the bar gone, the check becomes a no-op
// that we don't need to remove (one less code-path delta).
let controlBar = null
let recordingStartedAt = 0
let activeDraftId = null
let pendingStepCaptureQueue = Promise.resolve()
const THUMB_WIDTH = 600
const THUMB_HEIGHT = 360
const THUMB_CAPTURE_INTERVAL_MS = 650
const THUMB_STOP_MIN_WAIT_MS = 2500
const THUMB_STOP_MAX_WAIT_MS = 9000
let thumbnailCaptureQueue = Promise.resolve()
let lastThumbnailCaptureAt = 0
const pendingThumbnailCaptures = new Set()
let lastDraftPersistPromise = Promise.resolve(true)

function getChromeLastErrorMessage() {
  try {
    return chrome.runtime?.lastError?.message || ''
  } catch {
    return ''
  }
}

function requestActiveDraft(callback) {
  try {
    chrome.runtime.sendMessage({ type: 'recorder:get-active-draft' }, (response) => {
      const lastErrorMessage = getChromeLastErrorMessage()
      if (lastErrorMessage) {
        console.debug('[TipTour Recorder] active draft unavailable:', lastErrorMessage)
        callback(null)
        return
      }
      callback(response?.recording || null)
    })
  } catch {
    callback(null)
  }
}

function notifyDraftDiscarded() {
  try {
    chrome.runtime.sendMessage({ type: 'recorder:draft-discarded' }, () => {
      void chrome.runtime.lastError
    })
  } catch {
    /* extension context invalidated */
  }
}

function sendDraftUpdate(stepsToPersist) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        type: 'recorder:draft-updated',
        data: {
          draftId: activeDraftId,
          steps: stepsToPersist,
          domain: window.location.hostname,
          url: window.location.href,
        },
      }, (response) => {
        const lastErrorMessage = getChromeLastErrorMessage()
        resolve(!lastErrorMessage && response?.ok !== false)
      })
    } catch {
      resolve(false)
    }
  })
}

function currentExpectedUrlPattern() {
  try {
    const url = new URL(window.location.href)
    const normalizedPath = url.pathname
      .split('/')
      .map((segment) => {
        if (!segment) return segment
        const decoded = decodeURIComponent(segment)
        if (/^(acct_|cus_|usr_|org_|team_|proj_|wf_|rec_)/i.test(decoded)) return '*'
        if (/^[0-9]+$/.test(decoded)) return '*'
        if (/^[0-9a-f]{8,}$/i.test(decoded)) return '*'
        if (/^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(decoded)) return '*'
        if (decoded.length >= 12 && /[0-9]/.test(decoded) && /[a-z]/i.test(decoded)) return '*'
        return segment
      })
      .join('/')
    return `${url.origin}${normalizedPath}${url.search || url.hash ? '*' : ''}`
  } catch {
    return window.location.href
  }
}

/**
 * Tell the side panel about the current step list so the timeline
 * stays in sync. Sends only the lightweight metadata the panel
 * actually renders — full thumbDataUrl strings are heavy but worth
 * including, since the panel's whole point is showing the screenshots.
 *
 * Fire-and-forget — no response handling. The panel isn't always
 * open; chrome.runtime.lastError fires when no listener is alive,
 * which we swallow.
 */
function broadcastStepsToPanel() {
  try {
    chrome.runtime.sendMessage({
      type: 'recorder:steps-updated',
      steps,
      domain: window.location.hostname,
    }, () => {
      // Eat lastError when no panel is open. We don't care.
      void chrome.runtime.lastError
    })
  } catch {
    /* extension context invalidated */
  }
}

// ─── CDP Target Capture ─────────────────────────────────────────

function generateStepContentFromCapture(capture) {
  const name = typeof capture?.label === 'string' && capture.label.trim()
    ? capture.label.trim()
    : typeof capture?.tagName === 'string'
      ? capture.tagName.toLowerCase()
      : 'element'
  const short = name.length > 50 ? name.slice(0, 47) + '...' : name
  switch (capture?.actionType) {
    case 'click': return `Click "${short}"`
    case 'fill': return `Type in the "${short}" field`
    case 'select': return `Choose an option from "${short}"`
    case 'check': return `Check "${short}"`
    default: return `Interact with "${short}"`
  }
}

function captureTargetAtClick(clickX, clickY) {
  return new Promise((resolve, reject) => {
    try {
      const timeoutId = window.setTimeout(() => reject(new Error('timeout')), 5000)
      chrome.runtime.sendMessage({
        type: 'cdp:capture-target-at',
        x: clickX,
        y: clickY,
      }, (response) => {
        window.clearTimeout(timeoutId)
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'no-response'))
          return
        }
        if (!response || response.ok === false) {
          reject(new Error(response?.error || 'cdp-capture-failed'))
          return
        }
        resolve(response)
      })
    } catch (caught) {
      reject(caught)
    }
  })
}

// ─── Click Capture ───────────────────────────────────────────────

function handleClick(e) {
  if (!recording || paused) {
    console.log('[TipTour Recorder] click ignored — recording=', recording, 'paused=', paused);
    return;
  }

  // Ignore clicks on the small control bar (legacy guard — bar is
  // always null after the side-panel redesign, but the check is a
  // free no-op so we leave it).
  if (controlBar && controlBar.contains(e.target)) return

  const el = e.target.closest('button, a, input, select, textarea, [role="button"], [role="link"], label, [onclick]') || e.target
  console.log('[TipTour Recorder] click captured →', el.tagName);

  // Capture click point + viewport size NOW so the thumbnail's
  // marker is positioned relative to the screenshot we're about to
  // ask the background for. CSS pixels — same coordinate system the
  // screenshot resize uses, so the percentage placement works
  // identically across DPRs.
  const clickX = e.clientX
  const clickY = e.clientY
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const capturedAtMs = Date.now() - recordingStartedAt

  pendingStepCaptureQueue = pendingStepCaptureQueue
    .catch(() => {})
    .then(async () => {
      let capture
      try {
        capture = await captureTargetAtClick(clickX, clickY)
      } catch (caught) {
        console.warn('[TipTour Recorder] CDP target capture failed:', caught?.message || caught)
        showRecorderToast('Could not capture that click. Try reloading the page and recording again.', { kind: 'error' })
        return
      }

      const actionType = capture.actionType || 'click'
      const stepId = `step-${steps.length}`
      const step = {
        id: stepId,
        target: capture.target || {},
        title: '',
        content: generateStepContentFromCapture(capture),
        action: { type: actionType },
        transitions: [],
        // New panel-only metadata; ignored by the workflow runtime but
        // surfaced in the recording panel and in the post-recording
        // metadata modal (Phase 3) where we'll feed thumbnails to Claude
        // for slug + description generation.
        thumbDataUrl: null,
        clickPoint: { x: clickX, y: clickY },
        viewportSize: { width: viewportWidth, height: viewportHeight },
        capturedAtMs,
        expectedUrl: currentExpectedUrlPattern(),
      }
      if (capture.cdpCaptureError) {
        step.cdpCaptureError = capture.cdpCaptureError
      }

      // Do not capture user-entered values. Recorded tours should guide
      // the next user to type their own value, not wait for the exact
      // private value entered during recording.
      if (actionType === 'fill') {
        const inputEl = el.closest('input, textarea') || el
        const onBlur = () => {
          inputEl.removeEventListener('blur', onBlur)
          persistRecordingState()
        }
        inputEl.addEventListener('blur', onBlur)
      }

      steps.push(step)
      updateStepCounter()
      persistRecordingState()
      broadcastStepsToPanel()

      // Async-fetch the thumbnail and attach it once it returns.
      enqueueThumbnailCapture(step)
    })

  // Visual feedback: brief flash on captured element
  el.style.outline = '2px solid #22c55e'
  el.style.outlineOffset = '2px'
  setTimeout(() => {
    el.style.outline = ''
    el.style.outlineOffset = ''
  }, 300)
}

// ─── Control Bar ─────────────────────────────────────────────────
//
// Minimal black pill at the bottom-center of the page: red dot, step
// counter, Pause + Stop buttons. Kept intentionally small so it
// doesn't get in the recorder's way. Per-step thumbnails get
// captured silently and uploaded with the workflow on Stop — the
// admin tour-detail view is where the user sees them.

function createControlBar() {
  controlBar = document.createElement('div')
  controlBar.id = 'tiptour-recorder-bar'
  controlBar.innerHTML = `
    <style>
      #tiptour-recorder-bar {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 18px;
        background: #111;
        color: #fff;
        border-radius: 12px;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px;
        font-weight: 500;
        z-index: 2147483647;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        user-select: none;
      }
      #tiptour-recorder-bar .rec-dot {
        width: 8px; height: 8px;
        background: #ef4444;
        border-radius: 50%;
        animation: tiptour-rec-pulse 1s ease-in-out infinite;
      }
      #tiptour-recorder-bar.paused .rec-dot { animation: none; background: #666; }
      @keyframes tiptour-rec-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      #tiptour-recorder-bar button {
        background: rgba(255,255,255,0.15);
        border: none;
        color: #fff;
        padding: 5px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s;
      }
      #tiptour-recorder-bar button:hover { background: rgba(255,255,255,0.25); }
      #tiptour-recorder-bar .stop-btn { background: #ef4444; }
      #tiptour-recorder-bar .stop-btn:hover { background: #dc2626; }
      #tiptour-recorder-bar .step-counter { color: #999; font-size: 12px; min-width: 60px; }
    </style>
    <div class="rec-dot"></div>
    <span class="step-counter" id="tiptour-step-counter">0 steps</span>
    <button class="pause-btn" id="tiptour-pause-btn">Pause</button>
    <button class="stop-btn" id="tiptour-stop-btn">Stop</button>
  `
  document.body.appendChild(controlBar)
  document.getElementById('tiptour-pause-btn').addEventListener('click', togglePause)
  document.getElementById('tiptour-stop-btn').addEventListener('click', stopRecording)
}

function updateStepCounter() {
  const counter = document.getElementById('tiptour-step-counter')
  if (counter) {
    counter.textContent = `${steps.length} step${steps.length !== 1 ? 's' : ''}`
  }
}

function togglePause() {
  paused = !paused
  const btn = document.getElementById('tiptour-pause-btn')
  if (btn) btn.textContent = paused ? 'Resume' : 'Pause'
  if (controlBar) controlBar.classList.toggle('paused', paused)
}

// ─── Thumbnail capture ───────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function waitForThumbnailCaptureSlot() {
  const elapsedMs = Date.now() - lastThumbnailCaptureAt
  if (elapsedMs < THUMB_CAPTURE_INTERVAL_MS) {
    await delay(THUMB_CAPTURE_INTERVAL_MS - elapsedMs)
  }
  lastThumbnailCaptureAt = Date.now()
}

function enqueueThumbnailCapture(step) {
  const capturePromise = thumbnailCaptureQueue
    .catch(() => {})
    .then(waitForThumbnailCaptureSlot)
    .then(() => captureThumbnailForStep(step))

  pendingThumbnailCaptures.add(capturePromise)
  capturePromise.finally(() => pendingThumbnailCaptures.delete(capturePromise))
  thumbnailCaptureQueue = capturePromise
}

async function waitForPendingThumbnailCaptures(timeoutMs) {
  if (pendingThumbnailCaptures.size === 0) return
  await Promise.race([
    Promise.allSettled(Array.from(pendingThumbnailCaptures)),
    delay(timeoutMs),
  ])
}

/**
 * Ask the background worker for a screenshot of the visible tab,
 * downscale it client-side to THUMB_WIDTH × THUMB_HEIGHT to keep
 * the extension-owned recording draft reasonably small across many steps,
 * and attach the dataURL onto the step. Re-renders the panel so
 * the placeholder swaps to the real thumbnail. Background uses the
 * existing 'tiptour:capture-screen' message — same path the embed
 * uses for vision pointing. Captures are queued so rapid-click
 * recordings stay below Chrome's captureVisibleTab rate limit.
 */
async function captureThumbnailForStep(step) {
  try {
    const fullDataUrl = await new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => reject(new Error('timeout')), 5000)
      try {
        chrome.runtime.sendMessage({
          type: 'tiptour:capture-screen',
          reason: 'recorder-thumbnail',
        }, (response) => {
          window.clearTimeout(timeoutId)
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'no-response'))
            return
          }
          if (!response || response.disabled || response.error || !response.dataUrl) {
            const error = new Error(response?.error || 'no-data')
            if (response?.needsPermission) error.needsPermission = true
            reject(error)
            return
          }
          resolve(response.dataUrl)
        })
      } catch (caught) {
        window.clearTimeout(timeoutId)
        reject(caught)
      }
    })
    const downscaledDataUrl = await downscaleImageDataUrl(fullDataUrl, THUMB_WIDTH, THUMB_HEIGHT, 0.72)
    step.thumbDataUrl = downscaledDataUrl
    persistRecordingState()
    // Re-broadcast so the side panel swaps the shimmer placeholder
    // for the actual screenshot the moment it lands.
    broadcastStepsToPanel()
  } catch (caught) {
    if (caught?.needsPermission) {
      console.warn(
        '[TipTour Recorder] Step thumbnails need Chrome screenshot permission. ' +
        'Click "Record this site" again and allow site access when Chrome asks.'
      )
      return
    }
    console.warn('[TipTour Recorder] Failed to capture step thumbnail:', caught?.message || caught)
  }
}

function downscaleImageDataUrl(dataUrl, targetWidth, targetHeight, jpegQuality) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas-2d-unavailable')
        // cover-fit rather than contain-fit so the click marker
        // overlay (positioned in viewport %) stays geometrically
        // accurate — we crop the centre rather than letterboxing.
        const sourceAspect = image.naturalWidth / Math.max(1, image.naturalHeight)
        const targetAspect = targetWidth / targetHeight
        let sx = 0, sy = 0, sw = image.naturalWidth, sh = image.naturalHeight
        if (sourceAspect > targetAspect) {
          sw = image.naturalHeight * targetAspect
          sx = (image.naturalWidth - sw) / 2
        } else if (sourceAspect < targetAspect) {
          sh = image.naturalWidth / targetAspect
          sy = (image.naturalHeight - sh) / 2
        }
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight)
        resolve(canvas.toDataURL('image/jpeg', jpegQuality))
      } catch (caught) { reject(caught) }
    }
    image.onerror = () => reject(new Error('image-load-failed'))
    image.src = dataUrl
  })
}

// ─── Persistence ─────────────────────────────────────────────────

function persistRecordingState() {
  // Persist the draft in the extension background's IndexedDB. The
  // content script keeps an in-memory copy for immediate capture, but
  // the background copy survives service-worker restarts, panel closes,
  // and page navigations.
  const persistedSteps = steps.map((step) => ({ ...step }))
  const fallbackSteps = persistedSteps.map((step) => ({
    ...step,
    thumbDataUrl: undefined,
  }))
  lastDraftPersistPromise = sendDraftUpdate(persistedSteps)
    .then((ok) => ok || sendDraftUpdate(fallbackSteps))
    .catch(() => false)
  return lastDraftPersistPromise
}

async function flushRecordingState() {
  await pendingStepCaptureQueue.catch(() => {})
  await lastDraftPersistPromise.catch(() => false)
  return await persistRecordingState()
}

// ─── Start / Stop ────────────────────────────────────────────────

function startRecording(existingSteps, options) {
  // Resume from existing steps (cross-page navigation)
  steps = existingSteps || []
  activeDraftId = options?.draftId || activeDraftId || null
  recording = true
  paused = false
  recordingStartedAt = Date.now()

  // No in-page control bar anymore — recording is driven entirely
  // from the side panel. Push an initial state to it so a panel
  // opened mid-recording sees the same step list we already have.
  document.addEventListener('click', handleClick, true)
  broadcastStepsToPanel()

  console.log('[TipTour Recorder] Started recording')
}

function notifyRecorderStopped() {
  try {
    chrome.runtime.sendMessage({ type: 'recorder:stopped' }, () => {
      void chrome.runtime.lastError
    })
  } catch {
    /* extension context invalidated */
  }
}

function resumeRecordingAfterSaveFailure() {
  recording = true
  paused = false
  document.addEventListener('click', handleClick, true)
  persistRecordingState()
  broadcastStepsToPanel()
}

async function stopRecording(options) {
  const opts = options || {}
  await pendingStepCaptureQueue.catch(() => {})

  if (!opts.discard && steps.length === 0) {
    recording = true
    paused = false
    document.addEventListener('click', handleClick, true)
    const error = 'No steps captured.'
    showRecorderToast('No steps captured — click on the page before stopping.', { kind: 'error' })
    console.warn('[TipTour Recorder] Stop called with zero steps captured.')
    return { ok: false, error }
  }

  recording = false

  document.removeEventListener('click', handleClick, true)

  if (controlBar) {
    controlBar.remove()
    controlBar = null
  }

  // Wire linear transitions
  for (let i = 0; i < steps.length - 1; i++) {
    steps[i].transitions = [{ to: steps[i + 1].id }]
  }

  if (opts.discard) {
    notifyDraftDiscarded()
    activeDraftId = null
    showRecorderToast('Recording discarded.')
    notifyRecorderStopped()
    return { ok: true, discarded: true }
  }

  const thumbnailWaitMs = Math.min(
    THUMB_STOP_MAX_WAIT_MS,
    Math.max(
      THUMB_STOP_MIN_WAIT_MS,
      pendingThumbnailCaptures.size * THUMB_CAPTURE_INTERVAL_MS + 1000
    )
  )
  showRecorderToast(`Preparing ${steps.length} step${steps.length === 1 ? '' : 's'}…`, { spinner: true })
  await waitForPendingThumbnailCaptures(thumbnailWaitMs)
  const draftPersisted = await flushRecordingState()

  return new Promise((resolve) => {
    const domain = window.location.hostname

    // Steps include thumbDataUrl + clickPoint + viewportSize for any
    // step whose screenshot capture completed in time — the admin
    // tour-detail page renders these in the timeline view.
    const recordingData = {
      draftId: activeDraftId,
      steps: draftPersisted ? undefined : steps,
      stepCount: steps.length,
      domain,
      url: window.location.href,
      recordedAt: Date.now(),
      requestedSlug: typeof opts.requestedSlug === 'string' ? opts.requestedSlug : '',
    }

    showRecorderToast(`Saving ${steps.length} step${steps.length === 1 ? '' : 's'}…`, { spinner: true })

    chrome.runtime.sendMessage(
      { type: 'recording-complete', data: recordingData },
      (response) => {
        // chrome.runtime.lastError fires when the extension context is
        // gone (e.g. service worker crashed, extension was reloaded
        // mid-recording). Without this branch the failure is invisible.
        if (chrome.runtime.lastError) {
          console.error(
            '[TipTour Recorder] Message to background failed:',
            chrome.runtime.lastError
          )
          resumeRecordingAfterSaveFailure()
          showRecorderToast(
            'Could not reach the extension background — try reloading the extension and recording again.',
            { kind: 'error' }
          )
          resolve({
            ok: false,
            error: 'Could not reach the extension background.',
          })
          return
        }
        if (response && response.ok === false) {
          console.error('[TipTour Recorder] Publish failed:', response.error)
          resumeRecordingAfterSaveFailure()
          showRecorderToast(
            'Could not save the tour: ' + (response.error || 'unknown error'),
            { kind: 'error' }
          )
          resolve(response)
          return
        }
        activeDraftId = null
        showRecorderToast(
          `Saved! Opening admin… (${steps.length} step${steps.length === 1 ? '' : 's'}, siteId: ${domain})`,
          { kind: 'success' }
        )
        notifyRecorderStopped()
        resolve(response || { ok: true })
      }
    )

    console.log(
      `[TipTour Recorder] Stopped — ${steps.length} steps captured (siteId: ${domain} [hostname])`
    )
  })
}

/**
 * Render a transient toast at the bottom-right of the page so the
 * user gets immediate feedback when stopRecording fires. Without this
 * the recorder UI just disappears and the user has no idea whether
 * the tour was actually saved. Three variants:
 *   - default (neutral, used for "saving…" with optional spinner)
 *   - success (green, used after the admin tab opens)
 *   - error (red, used for any failure path)
 *
 * Auto-dismisses after 6s for non-error toasts; errors linger 12s
 * so the user has time to read them and copy/paste if needed.
 */
function showRecorderToast(message, options) {
  const opts = options || {}
  const kind = opts.kind || 'info'

  const existingToast = document.getElementById('tiptour-recorder-toast')
  if (existingToast) existingToast.remove()

  const toast = document.createElement('div')
  toast.id = 'tiptour-recorder-toast'
  toast.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'max-width:360px',
    'padding:12px 16px',
    'border-radius:10px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:13px',
    'line-height:1.5',
    'font-weight:500',
    'box-shadow:0 4px 16px rgba(0,0,0,0.16)',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'gap:10px',
    kind === 'success'
      ? 'background:#16a34a;color:#fff;border:1px solid #15803d'
      : kind === 'error'
        ? 'background:#dc2626;color:#fff;border:1px solid #b91c1c'
        : 'background:#1c1917;color:#fff;border:1px solid #292524',
  ].join(';')

  if (opts.spinner) {
    const spinner = document.createElement('div')
    spinner.style.cssText = [
      'width:14px',
      'height:14px',
      'border:2px solid rgba(255,255,255,0.3)',
      'border-top-color:#fff',
      'border-radius:999px',
      'animation:tiptour-spin 0.8s linear infinite',
      'flex-shrink:0',
    ].join(';')
    toast.appendChild(spinner)
    if (!document.getElementById('tiptour-recorder-spinner-keyframes')) {
      const styleSheet = document.createElement('style')
      styleSheet.id = 'tiptour-recorder-spinner-keyframes'
      styleSheet.textContent =
        '@keyframes tiptour-spin{to{transform:rotate(360deg)}}'
      document.head.appendChild(styleSheet)
    }
  }

  const text = document.createElement('span')
  text.textContent = message
  toast.appendChild(text)
  document.body.appendChild(toast)

  const dismissAfterMs = kind === 'error' ? 12000 : 6000
  setTimeout(() => {
    if (toast.parentElement) toast.remove()
  }, dismissAfterMs)
}

// ─── Message Handling ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start-recording') {
    startRecording(msg.existingSteps || null, { draftId: msg.draftId || null })
    sendResponse({ ok: true })
  }

  if (msg.type === 'stop-recording') {
    stopRecording({
      requestedSlug: typeof msg.requestedSlug === 'string' ? msg.requestedSlug : '',
    }).then(sendResponse)
    return true
  }

  if (msg.type === 'discard-recording') {
    stopRecording({ discard: true }).then(sendResponse)
    return true
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true, recording })
  }

  // ─── Side-panel commands ─────────────────────────────────
  // Forwarded by background.js from the panel UI. We mutate the
  // local steps array, persist to the extension draft DB, and
  // re-broadcast so the panel re-renders with the new state.

  if (msg.type === 'recorder:delete-step') {
    const targetId = msg.stepId
    const indexToRemove = steps.findIndex((step) => step.id === targetId)
    if (indexToRemove !== -1) {
      steps.splice(indexToRemove, 1)
      updateStepCounter()
      persistRecordingState()
      broadcastStepsToPanel()
    }
    sendResponse({ ok: true })
  }

  if (msg.type === 'recorder:toggle-pause') {
    paused = !paused
    sendResponse({ ok: true, paused })
  }
})

requestActiveDraft((recordingState) => {
  if (recordingState) {
    startRecording(recordingState.steps || [], { draftId: recordingState.draftId || null })
  }
})

})(); // close tiptourRecorderInit IIFE
