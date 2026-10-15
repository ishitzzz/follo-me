export class SessionManager {
    constructor() {
        this.currentSnapshot = {
            activeTabId: null,
            activeTabUrl: null,
            activeTabTitle: null,
            agentTask: null,
            lastUpdated: Date.now()
        };
    }

    initializeListeners() {
        // Tab activated
        chrome.tabs.onActivated.addListener((activeInfo) => {
            this.updateSnapshotFromTabId(activeInfo.tabId);
        });

        // Tab updated (e.g. loaded new URL)
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.status === 'complete' && tab.active) {
                this.updateSnapshotFromTabId(tabId);
            }
        });

        // Tab closed
        chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
            if (this.currentSnapshot.activeTabId === tabId) {
                this.currentSnapshot.activeTabId = null;
                this.currentSnapshot.activeTabUrl = null;
                this.currentSnapshot.activeTabTitle = null;
                this.saveSnapshot();
            }
        });
    }

    async updateSnapshotFromTabId(tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            this.currentSnapshot.activeTabId = tab.id;
            this.currentSnapshot.activeTabUrl = tab.url;
            this.currentSnapshot.activeTabTitle = tab.title;
            this.currentSnapshot.lastUpdated = Date.now();
            await this.saveSnapshot();
        } catch (error) {
            console.error("SessionManager: Failed to get tab info", error);
        }
    }

    async saveSnapshot() {
        try {
            await chrome.storage.local.set({ folloMeSession: this.currentSnapshot });
            console.log("SessionManager: Snapshot saved to local storage", this.currentSnapshot);
        } catch (error) {
            console.error("SessionManager: Failed to save snapshot", error);
        }
    }

    async refreshSnapshot() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs.length > 0) {
                await this.updateSnapshotFromTabId(tabs[0].id);
            } else {
                this.currentSnapshot.lastUpdated = Date.now();
                await this.saveSnapshot();
            }
        } catch (error) {
            console.error("SessionManager: Failed to refresh snapshot", error);
        }
    }

    setAgentTask(task) {
        this.currentSnapshot.agentTask = task;
        this.currentSnapshot.lastUpdated = Date.now();
        this.saveSnapshot();
    }

    updateContext(contextUpdates) {
        this.currentSnapshot = { ...this.currentSnapshot, ...contextUpdates };
        this.currentSnapshot.lastUpdated = Date.now();
        this.saveSnapshot();
    }
}
