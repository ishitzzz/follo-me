export class HybridExecutor {
    constructor() {
        this.debuggerVersion = '1.3';
        this.isNetworkIdle = true;
        this.idlePromiseResolver = null;
    }

    handleNetworkIdle() {
        this.isNetworkIdle = true;
        if (this.idlePromiseResolver) {
            this.idlePromiseResolver();
            this.idlePromiseResolver = null;
        }
    }

    async _waitForIdle() {
        if (this.isNetworkIdle) return;
        return new Promise(resolve => {
            this.idlePromiseResolver = resolve;
        });
    }

    async execute(tabId, actionPayload, requiresCdp) {
        this.isNetworkIdle = false; // reset on new execution
        // wait for idle if needed (optional pacing)
        // await this._waitForIdle();
        if (requiresCdp) {
            console.log("HybridExecutor: Canvas detected. Booting TipTour CDP Driver.");
            return await this.executeViaCDP(tabId, actionPayload);
        } else {
            console.log("HybridExecutor: Standard DOM detected. Executing natively.");
            return await this.executeViaDOM(tabId, actionPayload);
        }
    }

    async executeViaCDP(tabId, actionPayload) {
        const target = { tabId: tabId };
        
        try {
            await chrome.debugger.attach(target, this.debuggerVersion);
            
            // X, Y coords would be provided by the Offscreen Brain's JSON mapping
            const x = actionPayload.x || 0;
            const y = actionPayload.y || 0;
            const rect = actionPayload.rect || { 
                left: x, 
                top: y, 
                width: actionPayload.width || 30, 
                height: actionPayload.height || 30 
            };
            
            // Draw overlay before clicking
            chrome.tabs.sendMessage(tabId, { type: 'DRAW_OVERLAY', rect }).catch(() => {});

            // Small delay to let the user see the overlay
            await new Promise(r => setTimeout(r, 800));

            // PRE-CLICK SNAPSHOT Exact Timing Synchronization
            await chrome.tabs.sendMessage(tabId, { type: 'PRE_CLICK_SNAPSHOT' }).catch(() => {});

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
            
            // Clear overlay after action
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: 'CLEAR_OVERLAY' }).catch(() => {});
            }, 500);

            return true;
        } catch (error) {
            console.error("HybridExecutor (CDP) Failed:", error);
            return false;
        } finally {
            // ALWAYS detach immediately to hide the annoying Chrome warning banner
            try {
                await chrome.debugger.detach(target);
            } catch (e) {
                // Ignore detach errors if already detached
            }
        }
    }

    async executeViaDOM(tabId, actionPayload) {
        // Send message to content script to execute standard click()
        try {
            const rect = actionPayload.rect || { 
                left: actionPayload.x || 0, 
                top: actionPayload.y || 0, 
                width: actionPayload.width || 20, 
                height: actionPayload.height || 20 
            };
            chrome.tabs.sendMessage(tabId, { type: 'DRAW_OVERLAY', rect }).catch(() => {});
            
            await new Promise(r => setTimeout(r, 800));
            
            // PRE-CLICK SNAPSHOT Exact Timing Synchronization
            await chrome.tabs.sendMessage(tabId, { type: 'PRE_CLICK_SNAPSHOT' }).catch(() => {});
            
            await chrome.tabs.sendMessage(tabId, {
                type: 'EXECUTE_DOM_ACTION',
                payload: actionPayload
            });

            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: 'CLEAR_OVERLAY' }).catch(() => {});
            }, 500);

            return true;
        } catch (error) {
            console.error("HybridExecutor (DOM) Failed:", error);
            return false;
        }
    }
}
