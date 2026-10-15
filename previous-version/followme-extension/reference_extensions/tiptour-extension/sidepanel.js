/*
 * TipTour side panel controller.
 *
 * Two views, swapped via the [hidden] attribute:
 *   #idle-view      — record CTA + collapsed site override + tours + settings
 *   #recording-view — live timeline + control bar
 *
 * State sync:
 *   - Recorder content script broadcasts `recorder:steps-updated` with
 *     the full steps array on every change. Panel re-renders the
 *     timeline wholesale on each broadcast — no diffing.
 *   - Panel commands recorder via panel:* messages routed through
 *     background.js → forwardToRecorderTab().
 *
 * Diagnostic logs are kept on intentionally so you can pop the panel
 * into Chrome's "Inspect" view and see the message flow live without
 * a rebuild.
 */

const CONVEX_SITE_URL = CONFIG.CONVEX_SITE_URL;
const ADMIN_APP_URL = CONFIG.ADMIN_APP_URL;
const EXTENSION_TOKEN_STORAGE_KEY = 'tiptour-extension-token';

const idleView = document.getElementById('idle-view');
const recordingView = document.getElementById('recording-view');

const log = (...args) => console.log('[TipTour Panel]', ...args);

async function getExtensionToken() {
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(EXTENSION_TOKEN_STORAGE_KEY, resolve);
  });
  const token = stored && stored[EXTENSION_TOKEN_STORAGE_KEY];
  return typeof token === 'string' ? token.trim() : '';
}

// ─── Footer link ───────────────────────────────────────────

const openAdminLink = document.getElementById('open-admin-link');
if (openAdminLink) openAdminLink.href = ADMIN_APP_URL;

const openAdminIcon = document.getElementById('open-admin-icon');
if (openAdminIcon) {
  openAdminIcon.addEventListener('click', () => {
    chrome.tabs.create({ url: ADMIN_APP_URL });
  });
}

// ─── Current site ──────────────────────────────────────────

const currentSiteLabel = document.getElementById('current-site-label');

async function detectSiteId() {
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, resolve);
  });
  const activeTab = tabs && tabs[0];
  if (activeTab && activeTab.url) {
    try {
      return { siteId: new URL(activeTab.url).hostname.toLowerCase(), source: 'hostname' };
    } catch {
      return { siteId: '', source: 'hostname' };
    }
  }
  return { siteId: '', source: 'hostname' };
}

async function refreshCurrentSiteLabel() {
  const { siteId } = await detectSiteId();
  const label = siteId ? baseUrlLabelForSite(siteId) : 'Current site';
  if (currentSiteLabel) {
    currentSiteLabel.textContent = label;
    currentSiteLabel.title = label;
  }
}

function baseUrlLabelForSite(siteId) {
  const clean = String(siteId || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return clean ? `https://${clean}` : 'Current site';
}

// ─── Workspace connection token ─────────────────────────────

const workspaceTokenCurrent = document.getElementById('workspace-token-current');
const workspaceTokenInput = document.getElementById('workspace-token-input');
const workspaceTokenClear = document.getElementById('workspace-token-clear');

async function refreshWorkspaceTokenLabel() {
  const token = await getExtensionToken();
  if (workspaceTokenCurrent) workspaceTokenCurrent.textContent = token ? 'Connected' : 'Not connected';
  if (workspaceTokenClear) workspaceTokenClear.hidden = !token;
}

if (workspaceTokenInput) {
  getExtensionToken().then((token) => {
    workspaceTokenInput.value = token;
    void refreshWorkspaceTokenLabel();
  });
  let tokenDebounceTimerId = null;
  workspaceTokenInput.addEventListener('input', () => {
    if (tokenDebounceTimerId) clearTimeout(tokenDebounceTimerId);
    tokenDebounceTimerId = setTimeout(() => {
      const token = workspaceTokenInput.value.trim();
      chrome.storage.local.set({ [EXTENSION_TOKEN_STORAGE_KEY]: token });
      void refreshWorkspaceTokenLabel();
      void fetchAndRenderToursForCurrentSite();
    }, 300);
  });
}

if (workspaceTokenClear) {
  workspaceTokenClear.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.storage.local.remove(EXTENSION_TOKEN_STORAGE_KEY, () => {
      if (workspaceTokenInput) workspaceTokenInput.value = '';
      void refreshWorkspaceTokenLabel();
      void fetchAndRenderToursForCurrentSite();
    });
  });
}

// ─── Settings toggles ──────────────────────────────────────

function bindToggle(elementId, storageKey, defaultChecked) {
  const el = document.getElementById(elementId);
  if (!el) return;
  chrome.storage.local.get(storageKey, (stored) => {
    const value = stored[storageKey];
    el.checked = value === undefined ? defaultChecked : Boolean(value);
  });
  el.addEventListener('change', () => {
    chrome.storage.local.set({ [storageKey]: el.checked });
  });
}
bindToggle('visual-context-toggle', 'tiptour-visual-context', true);
bindToggle('voice-mode-toggle', 'tiptour-voice-mode', true);
bindToggle('visual-guidance-mode-toggle', 'tiptour-visual-guidance-mode', false);
bindToggle('autopilot-toggle', 'tiptour-autopilot', false);
bindToggle('airbnb-pointer-toggle', 'tiptour-airbnb-pointer', false);

// ─── Record button ─────────────────────────────────────────

const recordBtn = document.getElementById('record-btn');
const recordHint = document.getElementById('record-hint');

async function ensureRecorderThumbnailPermission() {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) {
    return { ok: false, error: 'Chrome permissions API unavailable.' };
  }
  const permission = { origins: ['<all_urls>'] };
  const alreadyGranted = await chrome.permissions.contains(permission);
  if (alreadyGranted) return { ok: true, alreadyGranted: true };
  const granted = await chrome.permissions.request(permission);
  return granted
    ? { ok: true, alreadyGranted: false }
    : {
        ok: false,
        error: 'Screenshot permission was not granted. Recording can continue, but step thumbnails will be missing.',
      };
}

if (recordBtn) {
  recordBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    log('record-btn click — active tab:', tab && { id: tab.id, url: tab.url });
    if (!tab || !tab.id) {
      alert('No active tab to record.');
      return;
    }
    const thumbnailPermission = await ensureRecorderThumbnailPermission();
    if (!thumbnailPermission.ok) {
      log('thumbnail permission unavailable:', thumbnailPermission.error);
      if (recordHint) recordHint.textContent = thumbnailPermission.error;
    } else if (recordHint) {
      recordHint.textContent = 'Click around your product to capture a tour.';
    }
    showRecordingView('Starting…', []);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'panel:start-recording',
        tabId: tab.id,
      });
      log('panel:start-recording response:', response);
      if (!response || response.ok !== true) {
        showIdleView();
        const errMsg = (response && (response.error || response.message)) || 'unknown';
        alert('Could not start recording: ' + errMsg);
      }
    } catch (err) {
      log('record-btn error:', err);
      showIdleView();
      alert('Could not start recording: ' + (err && err.message));
    }
  });
}

// ─── Tours for the current site ────────────────────────────

const toursSection = document.getElementById('tours-section');
const toursRows = document.getElementById('tours-rows');
const toursCount = document.getElementById('tours-count');
const idlePanelShell = document.querySelector('.panel-shell-idle');

async function fetchAndRenderToursForCurrentSite() {
  if (!toursSection || !toursRows) return;
  const { siteId } = await detectSiteId();
  if (!siteId) {
    toursSection.hidden = true;
    idlePanelShell?.classList.remove('has-tours');
    return;
  }
  let tours = [];
  try {
    // includeDrafts requires the creator bearer token now — without
    // it the server silently strips drafts. Pass the key the same
    // way the publish path does.
    const extensionToken = await getExtensionToken();
    const response = await fetch(
      `${CONVEX_SITE_URL}/workflows?domain=${encodeURIComponent(siteId)}&includeDrafts=true`,
      {
        headers: extensionToken
          ? { 'X-TipTour-Extension-Token': extensionToken }
          : { Authorization: `Bearer ${CONFIG.TIPTOUR_API_KEY}` },
      }
    );
    if (response.ok) tours = await response.json();
  } catch {
    /* network blip */
  }
  toursRows.innerHTML = '';
  if (!Array.isArray(tours) || tours.length === 0) {
    toursSection.hidden = true;
    idlePanelShell?.classList.remove('has-tours');
    return;
  }
  toursSection.hidden = false;
  idlePanelShell?.classList.add('has-tours');
  if (toursCount) toursCount.textContent = String(tours.length);
  tours.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const tour of tours) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tour-row';
    row.title = tour.description || '';

    const main = document.createElement('div');
    main.className = 'tour-row-main';

    const title = document.createElement('div');
    title.className = 'tour-row-title';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = tour.workflowId || tour.title || 'Untitled';
    titleSpan.title = tour.workflowId || tour.title || 'Untitled';
    titleSpan.style.overflow = 'hidden';
    titleSpan.style.textOverflow = 'ellipsis';
    title.appendChild(titleSpan);
    if (tour.active === false) {
      const draftBadge = document.createElement('span');
      draftBadge.className = 'tour-row-draft';
      draftBadge.textContent = 'Draft';
      title.appendChild(draftBadge);
    }
    main.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'tour-row-sub';
    const stepCount = tour.stepCount ?? 0;
    sub.textContent = `${stepCount} step${stepCount === 1 ? '' : 's'}`;
    main.appendChild(sub);

    row.appendChild(main);

    const arrow = document.createElement('div');
    arrow.className = 'tour-row-arrow';
    arrow.textContent = '→';
    row.appendChild(arrow);

    row.addEventListener('click', () => {
      void runWorkflowOnActiveTab(tour.workflowId);
    });
    toursRows.appendChild(row);
  }
}

async function runWorkflowOnActiveTab(workflowId) {
  if (!workflowId) return;
  try {
    const tabs = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, resolve);
    });
    const activeTab = tabs && tabs[0];
    if (!activeTab || !activeTab.id) return;
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get('tiptour-autopilot', resolve);
    });
    chrome.runtime.sendMessage({
      type: 'panel:start-tour',
      tabId: activeTab.id,
      workflowId,
      autoRun: stored && stored['tiptour-autopilot'] === true,
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch (err) {
    console.error('[TipTour Panel] runWorkflowOnActiveTab error:', err);
  }
}

// ─── Recording view rendering ──────────────────────────────

let panelRecordingState = null;
let isPaused = false;
let preferRecordingsOnNextIdle = false;

const recDomain = document.getElementById('rec-domain');
const recCounter = document.getElementById('rec-counter');
const recDot = document.getElementById('rec-dot');
const recEmpty = document.getElementById('rec-empty');
const recTimeline = document.getElementById('rec-timeline');
const recPauseBtn = document.getElementById('rec-pause');
const recDeleteAllBtn = document.getElementById('rec-delete-all');
const recDoneBtn = document.getElementById('rec-done');
const recMicBtn = document.getElementById('rec-mic');
const recSlugInput = document.getElementById('rec-slug-input');
let recSlugSaveTimerId = null;

function sanitizeWorkflowSlug(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

if (recSlugInput) {
  recSlugInput.addEventListener('input', () => {
    const sanitized = sanitizeWorkflowSlug(recSlugInput.value);
    if (recSlugInput.value !== sanitized) {
      recSlugInput.value = sanitized;
    }
    if (panelRecordingState) {
      panelRecordingState.requestedSlug = sanitized;
    }
    if (recSlugSaveTimerId) clearTimeout(recSlugSaveTimerId);
    recSlugSaveTimerId = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'panel:update-recording-meta',
        requestedSlug: sanitized,
      }, () => {
        void chrome.runtime.lastError;
      });
    }, 250);
  });
}

function showIdleView(options = {}) {
  if (idleView) idleView.hidden = false;
  if (recordingView) recordingView.hidden = true;
  panelRecordingState = null;
  recMicBtn?.classList.remove('active');
  if (recSlugInput) recSlugInput.value = '';
  if (options.preferRecordings) {
    idlePanelShell?.classList.add('has-tours');
  }
  void refreshCurrentSiteLabel();
  void refreshWorkspaceTokenLabel();
  void fetchAndRenderToursForCurrentSite();
}

function showRecordingView(domainLabel, steps, requestedSlug) {
  if (idleView) idleView.hidden = true;
  if (recordingView) recordingView.hidden = false;
  recMicBtn?.classList.add('active');
  if (recDomain) recDomain.textContent = domainLabel || '…';
  if (recSlugInput && typeof requestedSlug === 'string') {
    recSlugInput.value = sanitizeWorkflowSlug(requestedSlug);
  }
  renderTimeline(steps || []);
}

function renderTimeline(steps) {
  if (!recTimeline || !recEmpty || !recCounter) return;
  recCounter.textContent = String(steps.length);
  if (steps.length === 0) {
    recEmpty.hidden = false;
    recTimeline.hidden = true;
    if (recDoneBtn) recDoneBtn.disabled = true;
    return;
  }
  recEmpty.hidden = true;
  recTimeline.hidden = false;
  if (recDoneBtn) recDoneBtn.disabled = false;
  recTimeline.innerHTML = '';
  steps.forEach((step, index) => {
    recTimeline.appendChild(buildStepRow(step, index));
  });
  recTimeline.scrollTop = recTimeline.scrollHeight;
}

function describeStep(step) {
  const target = step.target || {};
  const role = (target.ref || '').split(':')[0] || '';
  const name = (target.ref || '').split(':').slice(1).join(':') || '';
  switch (step.type || step.action?.type) {
    case 'navigate':
      return `Navigate to ${step.url || '(unknown)'}`;
    case 'fill':
      return name ? `Type into "${name}"` : `Type into ${target.selector || 'input'}`;
    case 'select':
      return name ? `Select "${step.value || ''}" in "${name}"` : 'Select option';
    case 'check':
      return name ? `Check "${name}"` : 'Check input';
    case 'click':
    default:
      return name ? `Click "${name}"` : `Click ${target.selector || 'element'}`;
  }
}

function buildStepRow(step, index) {
  const row = document.createElement('div');
  row.className = 'rec-step';

  const num = document.createElement('div');
  num.className = 'rec-step-num';
  num.textContent = String(index + 1);
  row.appendChild(num);

  const body = document.createElement('div');
  body.className = 'rec-step-body';

  const desc = document.createElement('div');
  desc.className = 'rec-step-desc';
  desc.textContent = describeStep(step);
  body.appendChild(desc);

  // Only render the thumbnail if it's actually arrived. Earlier
  // versions showed an animated "loading" shimmer for missing thumbs,
  // but that's misleading when chrome.tabs.captureVisibleTab gets
  // rate-limited (~2/sec — rapid-fire clicks drop screenshots
  // permanently). Dropping the placeholder = no false "wait, still
  // loading…" promise. Steps without thumbs render as text only.
  if (step.thumbDataUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'rec-step-thumb';
    thumb.src = step.thumbDataUrl;
    thumb.alt = `Step ${index + 1}`;
    body.appendChild(thumb);
  }

  row.appendChild(body);

  const del = document.createElement('button');
  del.className = 'rec-step-delete';
  del.title = 'Delete step';
  del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  del.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'panel:delete-step', stepId: step.id });
  });
  row.appendChild(del);

  return row;
}

if (recPauseBtn) {
  recPauseBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'panel:toggle-pause' });
    isPaused = !isPaused;
    if (recDot) recDot.classList.toggle('paused', isPaused);
    recPauseBtn.classList.toggle('paused', isPaused);
    recPauseBtn.innerHTML = isPaused
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
  });
}

if (recDeleteAllBtn) {
  recDeleteAllBtn.addEventListener('click', async () => {
    if (!panelRecordingState || !panelRecordingState.steps?.length) {
      // Discard with no captured steps just exits the recording.
      await chrome.runtime.sendMessage({ type: 'panel:discard-recording' });
      showIdleView();
      return;
    }
    if (!confirm('Discard all captured steps and stop recording?')) return;
    const response = await chrome.runtime.sendMessage({ type: 'panel:discard-recording' });
    if (!response || response.ok !== true) {
      alert('Could not discard recording: ' + ((response && response.error) || 'unknown error'));
      return;
    }
    showIdleView();
  });
}

if (recDoneBtn) {
  recDoneBtn.addEventListener('click', async () => {
    recDoneBtn.disabled = true;
    recDoneBtn.textContent = 'Saving…';
    preferRecordingsOnNextIdle = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'panel:stop-recording',
        requestedSlug: sanitizeWorkflowSlug(recSlugInput?.value || ''),
      });
      if (!response || response.ok !== true) {
        preferRecordingsOnNextIdle = false;
        alert('Could not save recording: ' + ((response && response.error) || 'unknown error'));
        recDoneBtn.textContent = 'Retry';
        return;
      }
      showIdleView({ preferRecordings: true });
    } catch (err) {
      alert('Could not save recording: ' + (err && err.message ? err.message : 'unknown error'));
      recDoneBtn.textContent = 'Retry';
      preferRecordingsOnNextIdle = false;
    } finally {
      recDoneBtn.disabled = false;
      if (recDoneBtn.textContent === 'Saving…') recDoneBtn.textContent = 'Done';
    }
  });
}

// ─── Bootstrap ─────────────────────────────────────────────

(async function bootstrap() {
  chrome.storage.local.remove('tiptour-site-id-override', () => {
    void chrome.runtime.lastError;
  });
  await refreshCurrentSiteLabel();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'panel:get-state' });
    log('bootstrap state:', response);
    const recording = response && response.recording;
    if (recording && Array.isArray(recording.steps)) {
      panelRecordingState = recording;
      showRecordingView(recording.domain || '…', recording.steps, recording.requestedSlug || '');
    } else {
      showIdleView();
    }
  } catch (err) {
    log('bootstrap error:', err);
    showIdleView();
  }
})();

// ─── Listen for recorder broadcasts ────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'recorder:steps-updated') {
    log('recorder:steps-updated', { count: msg.steps?.length, domain: msg.domain });
    panelRecordingState = {
      ...(panelRecordingState || {}),
      steps: msg.steps || [],
      domain: msg.domain || (panelRecordingState && panelRecordingState.domain) || '',
      requestedSlug: sanitizeWorkflowSlug(recSlugInput?.value || panelRecordingState?.requestedSlug || ''),
    };
    if (idleView && !idleView.hidden) {
      showRecordingView(panelRecordingState.domain, panelRecordingState.steps, panelRecordingState.requestedSlug);
    } else {
      if (recDomain && panelRecordingState.domain) {
        recDomain.textContent = panelRecordingState.domain;
      }
      renderTimeline(panelRecordingState.steps);
    }
  }
  if (msg.type === 'recorder:stopped') {
    log('recorder:stopped');
    const preferRecordings = preferRecordingsOnNextIdle;
    preferRecordingsOnNextIdle = false;
    showIdleView({ preferRecordings });
  }
});
