/* TipTour active tour playback session.
 *
 * The page/embed process is disposable: every full navigation destroys it.
 * The extension background is the durable owner, so active playback progress
 * lives in chrome.storage.session and is scoped to the tab that started it.
 */
(function initTipTourRunSession() {
  const STORAGE_KEY = 'tourRun';

  function createRunId() {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `run-${Date.now()}-${randomPart}`;
  }

  function getChromeLastErrorMessage() {
    try {
      return chrome.runtime?.lastError?.message || '';
    } catch {
      return '';
    }
  }

  function normalizeTab(tab) {
    if (!tab || typeof tab.id !== 'number') return {};
    return {
      tabId: tab.id,
      ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
      ...(typeof tab.url === 'string' ? { currentUrl: tab.url } : {}),
    };
  }

  function sanitizeState(input, tab) {
    if (!input || typeof input !== 'object') return null;
    if (typeof input.workflowId !== 'string' || typeof input.currentStepId !== 'string') {
      return null;
    }
    const now = Date.now();
    const tabState = normalizeTab(tab);
    return {
      runId: typeof input.runId === 'string' ? input.runId : createRunId(),
      workflowId: input.workflowId,
      currentStepId: input.currentStepId,
      autoRun: input.autoRun === true,
      ...(input.config && typeof input.config === 'object' ? { config: input.config } : {}),
      currentUrl: typeof input.currentUrl === 'string'
        ? input.currentUrl
        : (tabState.currentUrl || ''),
      data: input.data && typeof input.data === 'object' ? input.data : {},
      history: Array.isArray(input.history) ? input.history : [],
      completedSteps: Array.isArray(input.completedSteps) ? input.completedSteps : [],
      startedAt: typeof input.startedAt === 'number' ? input.startedAt : now,
      updatedAt: now,
      expiresAt: typeof input.expiresAt === 'number' ? input.expiresAt : now + 30 * 60 * 1000,
      status: typeof input.status === 'string' ? input.status : 'running',
      ...tabState,
    };
  }

  function isExpired(run) {
    return Boolean(run && typeof run.expiresAt === 'number' && run.expiresAt < Date.now());
  }

  async function readRaw() {
    return await new Promise((resolve) => {
      try {
        const sessionStorage = chrome.storage?.session;
        if (!sessionStorage?.get) {
          resolve(null);
          return;
        }
        sessionStorage.get(STORAGE_KEY, (stored) => {
          const lastErrorMessage = getChromeLastErrorMessage();
          if (lastErrorMessage) {
            console.debug('[TipTour BG] tour session storage unavailable:', lastErrorMessage);
            resolve(null);
            return;
          }
          resolve(stored?.[STORAGE_KEY] || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function writeRaw(run) {
    try {
      if (run) {
        await chrome.storage.session.set({ [STORAGE_KEY]: run });
      } else {
        await chrome.storage.session.remove(STORAGE_KEY);
      }
    } catch {
      /* session storage can be unavailable in some extension contexts */
    }
  }

  async function getForTab(tabId) {
    const run = await readRaw();
    if (!run) return null;
    if (isExpired(run)) {
      await writeRaw(null);
      return null;
    }
    if (
      typeof tabId === 'number' &&
      typeof run.tabId === 'number' &&
      run.tabId !== tabId
    ) {
      return null;
    }
    return run;
  }

  async function saveFromContent(input, tab) {
    const existing = await getForTab(tab?.id);
    const sanitized = sanitizeState({
      ...(existing || {}),
      ...(input || {}),
      runId: existing?.runId,
    }, tab);
    if (!sanitized) return { ok: false, error: 'Invalid tour run state.' };
    await writeRaw(sanitized);
    return { ok: true, run: sanitized };
  }

  async function startForTab(tab, config, options = {}) {
    if (!config?.id || !config?.entryStep) {
      return { ok: false, error: 'Invalid workflow config.' };
    }
    const now = Date.now();
    const run = sanitizeState({
      workflowId: config.id,
      currentStepId: config.entryStep,
      autoRun: options.autoRun === true,
      config,
      currentUrl: tab?.url || '',
      data: {},
      history: [],
      completedSteps: [],
      startedAt: now,
      expiresAt: now + 30 * 60 * 1000,
      status: 'running',
    }, tab);
    if (!run) return { ok: false, error: 'Invalid tour run state.' };
    await writeRaw(run);
    return { ok: true, run };
  }

  async function clearForTab(tabId) {
    const run = await readRaw();
    if (!run) return { ok: true };
    if (
      typeof tabId === 'number' &&
      typeof run.tabId === 'number' &&
      run.tabId !== tabId
    ) {
      return { ok: true };
    }
    await writeRaw(null);
    return { ok: true };
  }

  async function transferToTab(sourceTabId, targetTab) {
    const run = await readRaw();
    if (!run) return { ok: false, error: 'No active tour run.' };
    if (isExpired(run)) {
      await writeRaw(null);
      return { ok: false, error: 'Tour run expired.' };
    }
    if (
      typeof sourceTabId === 'number' &&
      typeof run.tabId === 'number' &&
      run.tabId !== sourceTabId
    ) {
      return { ok: false, error: 'Tour run belongs to another tab.' };
    }
    const transferred = {
      ...run,
      ...normalizeTab(targetTab),
      updatedAt: Date.now(),
      status: 'running',
    };
    await writeRaw(transferred);
    return { ok: true, run: transferred };
  }

  self.TipTourRunSession = {
    clearForTab,
    getForTab,
    saveFromContent,
    startForTab,
    transferToTab,
  };
})();
