/* TipTour recording draft storage — extension-owned IndexedDB */

(function initTipTourRecordingDb() {
  const DB_NAME = 'tiptour-recorder';
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('drafts')) {
          const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
          drafts.createIndex('by_status', 'status', { unique: false });
          drafts.createIndex('by_tabId', 'tabId', { unique: false });
          drafts.createIndex('by_updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('steps')) {
          const steps = db.createObjectStore('steps', { keyPath: 'key' });
          steps.createIndex('by_draftId', 'draftId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function waitForTransaction(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  function getStoreValue(store, key) {
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function getDraft(draftId) {
    if (!draftId) return null;
    const db = await openDb();
    const tx = db.transaction('drafts', 'readonly');
    const done = waitForTransaction(tx);
    const draft = await getStoreValue(tx.objectStore('drafts'), draftId);
    await done;
    db.close();
    return draft;
  }

  async function listSteps(draftId) {
    if (!draftId) return [];
    const db = await openDb();
    const tx = db.transaction('steps', 'readonly');
    const done = waitForTransaction(tx);
    const index = tx.objectStore('steps').index('by_draftId');
    const rows = [];

    await new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(draftId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        rows.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await done;
    db.close();
    rows.sort((a, b) => (a.order || 0) - (b.order || 0));
    return rows.map((row) => row.step).filter(Boolean);
  }

  async function saveDraftState(draft, steps) {
    const existingDraft = await getDraft(draft.id);
    const db = await openDb();
    const tx = db.transaction(['drafts', 'steps'], 'readwrite');
    const done = waitForTransaction(tx);
    const draftsStore = tx.objectStore('drafts');
    const stepsStore = tx.objectStore('steps');
    const now = Date.now();
    const nextDraft = {
      ...(existingDraft || {}),
      ...draft,
      createdAt: existingDraft?.createdAt || draft.createdAt || now,
      updatedAt: now,
    };

    await new Promise((resolve, reject) => {
      const index = stepsStore.index('by_draftId');
      const request = index.openCursor(IDBKeyRange.only(draft.id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          draftsStore.put(nextDraft);
          (steps || []).forEach((step, order) => {
            stepsStore.put({
              key: `${draft.id}:${step.id || order}`,
              draftId: draft.id,
              stepId: step.id || String(order),
              order,
              step,
              updatedAt: now,
            });
          });
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await done;
    db.close();
    return nextDraft;
  }

  async function deleteDraft(draftId) {
    if (!draftId) return;
    const db = await openDb();
    const tx = db.transaction(['drafts', 'steps'], 'readwrite');
    const done = waitForTransaction(tx);
    const draftsStore = tx.objectStore('drafts');
    const stepsStore = tx.objectStore('steps');

    await new Promise((resolve, reject) => {
      const index = stepsStore.index('by_draftId');
      const request = index.openCursor(IDBKeyRange.only(draftId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          draftsStore.delete(draftId);
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await done;
    db.close();
  }

  self.TipTourRecordingDb = {
    deleteDraft,
    getDraft,
    listSteps,
    saveDraftState,
  };
})();
