/* TipTour recording session lifecycle — active draft pointer + draft hydration */

(function initTipTourRecordingSession() {
  const recordingDb = self.TipTourRecordingDb;

  function createDraftId() {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `draft-${Date.now()}-${randomPart}`;
  }

  function getChromeLastErrorMessage() {
    try {
      return chrome.runtime?.lastError?.message || '';
    } catch {
      return '';
    }
  }

  function hostnameFromUrl(url) {
    try {
      return url ? new URL(url).hostname.toLowerCase() : '';
    } catch {
      return '';
    }
  }

  async function getPointer() {
    return await new Promise((resolve) => {
      try {
        const sessionStorage = chrome.storage?.session;
        if (!sessionStorage?.get) {
          resolve(null);
          return;
        }
        sessionStorage.get('recording', (stored) => {
          const lastErrorMessage = getChromeLastErrorMessage();
          if (lastErrorMessage) {
            console.debug('[TipTour BG] session storage unavailable:', lastErrorMessage);
            resolve(null);
            return;
          }
          resolve(stored?.recording || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function setPointer(recording) {
    try {
      await chrome.storage.session.set({ recording });
    } catch {
      /* session storage can be unavailable in some extension contexts */
    }
  }

  async function getActive() {
    const pointer = await getPointer();
    if (!pointer) return null;
    if (!pointer.draftId) return pointer;
    try {
      const [draft, steps] = await Promise.all([
        recordingDb.getDraft(pointer.draftId),
        recordingDb.listSteps(pointer.draftId),
      ]);
      return {
        ...pointer,
        ...(draft || {}),
        steps,
      };
    } catch (err) {
      console.warn('[TipTour BG] failed to load active recording draft:', err);
      return {
        ...pointer,
        steps: [],
      };
    }
  }

  async function createDraftForTab(tabId, url) {
    const now = Date.now();
    const draftId = createDraftId();
    const domain = hostnameFromUrl(url);
    await recordingDb.saveDraftState({
      id: draftId,
      tabId,
      domain,
      url: url || '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }, []);
    return {
      draftId,
      tabId,
      domain,
      url: url || '',
      startedAt: now,
    };
  }

  async function activateDraft(draftPointer) {
    await setPointer(draftPointer);
  }

  async function clearDraftIfActive(draftId) {
    await recordingDb.deleteDraft(draftId);
    const pointer = await getPointer();
    if (pointer?.draftId === draftId) {
      await setPointer(null);
    }
  }

  async function clearActive() {
    const pointer = await getPointer();
    await setPointer(null);
    if (pointer?.draftId) {
      await recordingDb.deleteDraft(pointer.draftId);
    }
  }

  async function updateActiveDraft(data, senderTabId) {
    const pointer = await getPointer();
    if (!pointer?.draftId) {
      return { ok: false, error: 'No recording draft is active.' };
    }
    if (
      typeof senderTabId === 'number' &&
      typeof pointer.tabId === 'number' &&
      pointer.tabId !== senderTabId
    ) {
      return { ok: false, error: 'Recording draft belongs to another tab.' };
    }

    const steps = Array.isArray(data?.steps) ? data.steps : [];
    const domain = data?.domain || pointer.domain || '';
    const url = data?.url || pointer.url || '';
    const requestedSlug =
      typeof data?.requestedSlug === 'string'
        ? data.requestedSlug.trim()
        : (pointer.requestedSlug || '');
    await recordingDb.saveDraftState({
      id: pointer.draftId,
      tabId: pointer.tabId,
      domain,
      url,
      requestedSlug,
      status: 'active',
      stepCount: steps.length,
    }, steps);
    await setPointer({
      ...pointer,
      domain,
      url,
      requestedSlug,
      updatedAt: Date.now(),
    });
    return { ok: true, draftId: pointer.draftId };
  }

  async function updateActiveMetadata(data) {
    const pointer = await getPointer();
    if (!pointer?.draftId) {
      return { ok: false, error: 'No recording draft is active.' };
    }
    const requestedSlug =
      typeof data?.requestedSlug === 'string'
        ? data.requestedSlug.trim()
        : (pointer.requestedSlug || '');
    try {
      const draft = await recordingDb.getDraft(pointer.draftId);
      if (draft) {
        await recordingDb.saveDraftState({
          ...draft,
          requestedSlug,
          updatedAt: Date.now(),
        }, await recordingDb.listSteps(pointer.draftId));
      }
    } catch (err) {
      console.warn('[TipTour BG] failed to persist recording metadata:', err);
    }
    await setPointer({
      ...pointer,
      requestedSlug,
      updatedAt: Date.now(),
    });
    return { ok: true, draftId: pointer.draftId };
  }

  self.TipTourRecordingSession = {
    activateDraft,
    clearActive,
    clearDraftIfActive,
    createDraftForTab,
    getActive,
    getPointer,
    setPointer,
    updateActiveDraft,
    updateActiveMetadata,
  };
})();
