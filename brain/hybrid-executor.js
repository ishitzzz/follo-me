export class HybridExecutor {
    constructor() {
        this.debuggerVersion = '1.3';
        this.isNetworkIdle = true;
        this.idlePromiseResolver = null;
        this.attachedTabId = null;
        this.pendingRequests = new Set();
        this.idleTimeout = null;
        this.connectionPromise = null;
        this._debuggerEventCallback = this._debuggerEventCallback.bind(this);
        this._debuggerDetachCallback = this._debuggerDetachCallback.bind(this);
        this._tabRemovedCallback = this._tabRemovedCallback.bind(this);
    }

    async connect(tabId) {
        if (this.attachedTabId === tabId) return;
        
        while (this.connectionPromise) {
            await this.connectionPromise;
            if (this.attachedTabId === tabId) return;
        }
        
        this.connectionPromise = (async () => {
            if (this.attachedTabId) {
                await this.disconnect();
            }
            
            const target = { tabId };
            try {
                await chrome.debugger.attach(target, this.debuggerVersion);
                chrome.debugger.onEvent.addListener(this._debuggerEventCallback);
                chrome.debugger.onDetach.addListener(this._debuggerDetachCallback);
                chrome.tabs.onRemoved.addListener(this._tabRemovedCallback);
                this.attachedTabId = tabId;
                await chrome.debugger.sendCommand(target, 'Network.enable');
                this.pendingRequests.clear();
                this.isNetworkIdle = true;
                console.log(`HybridExecutor: Attached to tab ${tabId} and enabled Network tracking.`);
            } catch (e) {
                console.error("HybridExecutor: Failed to attach debugger", e);
                throw e;
            } finally {
                this.connectionPromise = null;
            }
        })();

        await this.connectionPromise;
    }
    
    async disconnect() {
        try {
            chrome.debugger.onEvent.removeListener(this._debuggerEventCallback);
            chrome.debugger.onDetach.removeListener(this._debuggerDetachCallback);
            chrome.tabs.onRemoved.removeListener(this._tabRemovedCallback);
        } catch (e) {
            // Ignore listener removal errors
        }

        if (!this.attachedTabId) return;
        const target = { tabId: this.attachedTabId };
        try {
            await chrome.debugger.detach(target);
            console.log(`HybridExecutor: Detached from tab ${this.attachedTabId}.`);
        } catch (e) {
            // Ignore detach errors if already detached
        }
        this.attachedTabId = null;
    }
    
    _debuggerEventCallback(source, method, params) {
        if (source.tabId !== this.attachedTabId) return;
        
        if (method === 'Network.requestWillBeSent') {
            this.pendingRequests.add(params.requestId);
            this.isNetworkIdle = false;
            if (this.idleTimeout) {
                clearTimeout(this.idleTimeout);
                this.idleTimeout = null;
            }
        } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
            this.pendingRequests.delete(params.requestId);
            if (this.pendingRequests.size === 0) {
                if (this.idleTimeout) clearTimeout(this.idleTimeout);
                this.idleTimeout = setTimeout(() => {
                    this.handleNetworkIdle();
                }, 500); // 500ms network idle threshold
            }
        }
    }

    handleNetworkIdle() {
        this.isNetworkIdle = true;
        if (this.idlePromiseResolver) {
            this.idlePromiseResolver();
            this.idlePromiseResolver = null;
        }
    }

    async waitForNetworkIdle(timeout = 5000) {
        if (this.isNetworkIdle && this.pendingRequests.size === 0) return;
        return new Promise(resolve => {
            let timer = null;
            this.idlePromiseResolver = () => {
                if (timer) clearTimeout(timer);
                resolve();
            };
            if (timeout > 0) {
                timer = setTimeout(() => {
                    if (this.idlePromiseResolver) {
                        this.pendingRequests.clear();
                        this.handleNetworkIdle();
                    }
                }, timeout);
            }
        });
    }

    _debuggerDetachCallback(source, reason) {
        if (source.tabId === this.attachedTabId) {
            this.attachedTabId = null;
            this.handleNetworkIdle();
        }
    }

    _tabRemovedCallback(tabId, removeInfo) {
        if (tabId === this.attachedTabId) {
            this.attachedTabId = null;
            this.handleNetworkIdle();
        }
    }

    async execute(tabId, actionPayload, requiresCdp, abortSignal) {
        // Ensure connected
        await this.connect(tabId);
        
        try {
            // Draw overlay before clicking
            chrome.tabs.sendMessage(tabId, { type: 'DRAW_TIPTOUR_OVERLAY', coordinates: actionPayload, instruction: actionPayload.instruction }).catch(() => {});

            if (abortSignal && abortSignal.aborted) {
                return { success: false };
            }

            // Small delay to let the user see the overlay, with abort support
            await new Promise(resolve => {
                const timer = setTimeout(resolve, 800);
                if (abortSignal) {
                    abortSignal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    }, { once: true });
                }
            });

            if (abortSignal && abortSignal.aborted) {
                console.log("HybridExecutor: Execution aborted during visual delay.");
                return { success: false };
            }

            // PRE-CLICK SNAPSHOT Exact Timing Synchronization
            await chrome.tabs.sendMessage(tabId, { type: 'PRE_CLICK_SNAPSHOT' }).catch(() => {});

            this.isNetworkIdle = false; // Reset on new execution, assuming it will trigger activity
            this.pendingRequests.clear();
            if (this.idleTimeout) {
                clearTimeout(this.idleTimeout);
                this.idleTimeout = null;
            }

            try {
                console.log("HybridExecutor: Attempting standard DOM execution.");
                await this.executeViaDOM(tabId, actionPayload);
                return true;
            } catch (error) {
                console.log("HybridExecutor: DOM execution failed. Falling back to CDP Driver.", error);
                return await this.executeViaCDP(tabId, actionPayload);
            }
        } finally {
            // Clear overlay after action
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: 'CLEAR_OVERLAY' }).catch(() => {});
            }, 500);
            
            // If no active requests were triggered, allow resolving idle quickly
            if (this.pendingRequests.size === 0) {
                this.idleTimeout = setTimeout(() => {
                    this.handleNetworkIdle();
                }, 500);
            }
        }
    }

    async executeViaCDP(tabId, actionPayload) {
        const target = { tabId: tabId };
        
        try {
            // X, Y coords would be provided by the Offscreen Brain's JSON mapping
            const x = actionPayload.x || 0;
            const y = actionPayload.y || 0;
            
            // TipTour native OS-level click sequence
            await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: x,
                y: y,
                button: 'left',
                clickCount: 1
            });
            
            await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: x,
                y: y,
                button: 'left',
                clickCount: 1
            });
            
            console.log(`HybridExecutor (CDP): Clicked at ${x}, ${y}`);
            
            return true;
        } catch (error) {
            console.error("HybridExecutor (CDP) Failed:", error);
            throw error;
        }
    }

    async executeViaDOM(tabId, actionPayload) {
        // Send message to content script to execute standard click()
        try {
            const response = await chrome.tabs.sendMessage(tabId, {
                type: 'EXECUTE_DOM_ACTION',
                payload: actionPayload
            });

            if (response && response.success === false) {
                throw new Error(response.error || 'DOM execution returned failure');
            }

            return true;
        } catch (error) {
            console.error("HybridExecutor (DOM) Failed:", error);
            throw error;
        }
    }
}
