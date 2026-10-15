import { config } from '../config.js';

export class GhostScoutOrchestrator {
    constructor() {
        this.scoutMap = new Map();
        this.successfulSelectors = new Map();
        
        // Clean up when tabs are closed to prevent memory leaks
        chrome.tabs.onRemoved.addListener((tabId) => {
            if (this.scoutMap.has(tabId)) {
                this.scoutMap.delete(tabId);
            }
        });
    }

    /**
     * Spawns a hidden background tab and waits for it to become completely idle (no mutations).
     * @param {string} targetUrl The URL to navigate to.
     * @returns {Promise<number>} Resolves with the tabId once settled.
     */
    async manageTab(targetUrl) {
        return new Promise((resolve, reject) => {
            chrome.tabs.create({ url: targetUrl, active: true }, (tab) => {
                if (!tab || !tab.id) {
                    return reject(new Error("Failed to create Ghost Scout tab."));
                }
                
                const tabId = tab.id;
                console.log(`[GhostScoutOrchestrator] Spawned Ghost Tab ${tabId} for ${targetUrl}`);
                
                // Forceful Injection Assurance (Fix Breakage Point 1)
                const onUpdatedListener = (updatedTabId, changeInfo) => {
                    if (updatedTabId === tabId && changeInfo.status === 'loading') {
                        chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            files: [
                                'brain/rrweb-tracker.js', 
                                'utils/context-extractor.js', 
                                'content/SemanticSnapper.js', 
                                'content/SafetyChecker.js', 
                                'content/action-listener.js'
                            ]
                        }).catch(e => console.warn("[GhostScoutOrchestrator] Injection error/skip:", e));
                        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
                    }
                };
                chrome.tabs.onUpdated.addListener(onUpdatedListener);
                
                // Initialize State Tracker
                const state = {
                    status: 'LOADING',
                    tabId: tabId,
                    url: targetUrl,
                    resolve: resolve,
                    reject: reject,
                    timeout: null,
                    triageAttempts: 0,
                    failedSelectors: []
                };
                this.scoutMap.set(tabId, state);

                // Set 15s watchdog to prevent infinite hanging
                state.timeout = setTimeout(() => {
                    console.warn(`[GhostScoutOrchestrator] Tab ${tabId} timed out. Forcing PAGE_SETTLED.`);
                    this._settleTab(tabId);
                }, 15000);
            });
        });
    }

    async handleNetworkIdle(tabId) {
        if (!this.scoutMap.has(tabId)) return;
        console.log(`[GhostScoutOrchestrator] Tab ${tabId} reached NETWORK_IDLE.`);
        this._settleTab(tabId);
    }

    async handlePopupDetected(tabId, htmlChunk) {
        let state = this.scoutMap.get(tabId);
        
        // If it's a tab we don't track but has folloMe injected, track it for continuous popup triage
        if (!state) {
            state = { triageAttempts: 0, failedSelectors: [] };
            this.scoutMap.set(tabId, state);
        }

        console.log(`[GhostScoutOrchestrator] Tab ${tabId} detected a popup. Triage initiated. Attempt: ${state.triageAttempts + 1}`);
        
        if (state.triageAttempts >= 3) {
            console.warn(`[GhostScoutOrchestrator] Tab ${tabId} popup triage failed 3 times. Aborting.`);
            throw new Error(`Popup triage failed 3 times on tab ${tabId}. Hard abort triggered.`);
        }
        
        let domain = null;
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab && tab.url) domain = new URL(tab.url).hostname;
        } catch (e) {}

        let selector = null;
        let usedCached = false;

        if (domain && this.successfulSelectors.has(domain)) {
            selector = this.successfulSelectors.get(domain);
            usedCached = true;
            console.log(`[GhostScoutOrchestrator] Found cached resolution button for ${domain}: ${selector}`);
        } else {
            // 1. Ask LLM for the CSS selector of the close/accept button, avoiding previous failures
            selector = await this._queryGroqForCloseButton(htmlChunk, state.failedSelectors);
        }
        
        if (selector && selector !== 'NOT_FOUND') {
            if (!usedCached) {
                console.log(`[GhostScoutOrchestrator] Found resolution button: ${selector}. Executing click.`);
                state.failedSelectors.push(selector); // remember it in case it fails
            }
            state.triageAttempts++;
            
            // 2. Dispatch synthetic click via content script
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: (targetSelector) => {
                    try {
                        const btn = document.querySelector(targetSelector);
                        if (btn) {
                            btn.click();
                            return true;
                        }
                        return false;
                    } catch(e) { return false; }
                },
                args: [selector]
            }).catch(e => { return [{ result: false }]; });
            
            if (results && results[0] && results[0].result) {
                console.log(`[GhostScoutOrchestrator] Successfully clicked ${selector}.`);
                state.failedSelectors = state.failedSelectors.filter(s => s !== selector);
                if (!usedCached && domain) {
                    this.successfulSelectors.set(domain, selector);
                    if (this.successfulSelectors.size > 50) {
                        this.successfulSelectors.delete(this.successfulSelectors.keys().next().value);
                    }
                }
            } else {
                console.warn(`[GhostScoutOrchestrator] Failed to click ${selector} on screen. Selector invalid or not found in DOM.`);
                if (usedCached) {
                    if (domain) this.successfulSelectors.delete(domain);
                    state.failedSelectors.push(selector);
                }
            }
            
            // Tell frontend we finished the attempt so it can rescan
            chrome.tabs.sendMessage(tabId, { type: 'POPUP_TRIAGE_COMPLETE' }).catch(() => {});
            
        } else {
            console.log(`[GhostScoutOrchestrator] No resolution button found by LLM. Ignoring popup.`);
            // No button found, immediately start cooldown so we don't spam the LLM
            state.failedSelectors = [];
            chrome.tabs.sendMessage(tabId, { type: 'POPUP_IGNORE_COOLDOWN' }).catch(() => {});
        }
    }

    async _queryGroqForCloseButton(htmlChunk, failedSelectors = []) {
        const failedText = failedSelectors.length > 0 
            ? `\nCRITICAL: You previously suggested the following selectors, but they FAILED. Do NOT suggest them again:\n${failedSelectors.join(', ')}\n` 
            : '';

        const prompt = `
You are an expert web scraping agent. A popup, modal, or cookie banner is blocking the screen.
Your job is to find the CSS selector for the button that will get rid of it most effectively. 
This might be a 'Close', 'Dismiss', 'X', or 'Decline' button, OR it might be an 'Accept All Cookies' or 'Agree' button. 
Choose the safest, most direct path to clear the screen.${failedText}
Return ONLY a raw JSON object with the key "selector".
If you cannot find one, return {"selector": "NOT_FOUND"}.

HTML:
${htmlChunk.substring(0, 3000)}
`;
        const fetchFromGroq = async () => {
            const response = await fetch(config.LLAMA_PROVIDER_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.LLAMA_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: config.FAST_MODEL,
                    messages: [{ role: 'system', content: prompt }],
                    temperature: 0.1,
                    response_format: { type: "json_object" }
                })
            });
            if (!response.ok) throw new Error("Groq API failed");
            const data = await response.json();
            const result = JSON.parse(data.choices[0].message.content.trim());
            return result.selector || 'NOT_FOUND';
        };

        const fetchFromOpenRouter = async () => {
            const response = await fetch(config.OPENROUTER_PROVIDER_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://follome.app',
                    'X-Title': 'FolloMe'
                },
                body: JSON.stringify({
                    model: config.FALLBACK_FAST_MODEL || "google/gemini-2.5-flash",
                    messages: [{ role: 'system', content: prompt }],
                    temperature: 0.1
                })
            });
            if (!response.ok) throw new Error("OpenRouter API failed");
            const data = await response.json();
            let content = data.choices[0].message.content.trim();
            // Handle markdown codeblocks
            if (content.startsWith('\`\`\`json')) content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
            const result = JSON.parse(content);
            return result.selector || 'NOT_FOUND';
        };

        try {
            return await fetchFromGroq();
        } catch (e) {
            console.warn("[GhostScoutOrchestrator] Groq query failed. Retrying with Gemini Flash Fallback...", e);
            try {
                return await fetchFromOpenRouter();
            } catch (fallbackError) {
                console.error("[GhostScoutOrchestrator] Fallback query failed:", fallbackError);
                return 'NOT_FOUND';
            }
        }
    }

    _settleTab(tabId) {
        const state = this.scoutMap.get(tabId);
        if (state) {
            if (state.timeout) clearTimeout(state.timeout);
            state.status = 'PAGE_SETTLED';
            console.log(`[GhostScoutOrchestrator] Tab ${tabId} is now settled and ready for execution.`);
            if (state.resolve) state.resolve(tabId);
            // DO NOT delete tab from scoutMap, we keep it for continuous popup triage!
            state.resolve = null;
            state.reject = null;
        }
    }
}
