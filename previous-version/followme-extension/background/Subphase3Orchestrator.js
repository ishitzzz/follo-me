import { config } from '../config.js';

export class Subphase3Orchestrator {
    constructor() {
        this.scrollAttempts = new Map(); // Tracks scroll attempts per tab
    }

    /**
     * Executes the Grounding & Vision Orchestration pipeline.
     * @param {number} tabId The ghost scout tab.
     * @param {object} step The planned step from Subphase 1.
     * @returns {Promise<object>} Resolves with physical coordinates or Escalation signal.
     */
    async executeStep(tabId, step) {
        console.log(`[Subphase3Orchestrator] Executing step on tab ${tabId}:`, step);
        
        // 0. Bring the tab to the foreground so the user can watch the bot work.
        // This also allows us to use chrome.tabs.captureVisibleTab without CDP.
        await chrome.tabs.update(tabId, { active: true });
        
        // 1. Fast Path (DOM Grounding)
        // Bypass Fast Path if we are in a REFLECT retry loop (history exists) so the Vision model can heal the hallucination.
        if (!step.history || step.history.length === 0) {
            const fastPathResult = await this._runFastPath(tabId, step);
            if (fastPathResult && fastPathResult.status === 'SUCCESS') {
                console.log(`[Subphase3Orchestrator] Fast Path succeeded:`, fastPathResult.actionPayload);
                return fastPathResult;
            }
            console.warn(`[Subphase3Orchestrator] Fast Path failed. Falling back to Vision Path.`);
        } else {
            console.log(`[Subphase3Orchestrator] Skipping Fast Path (REFLECT state detected). Forcing Vision Path.`);
        }
        
        // 2. Vision Path (UI-TARS)
        const visionPathResult = await this._runVisionPath(tabId, step);
        if (visionPathResult && visionPathResult.status === 'SUCCESS') {
            console.log(`[Subphase3Orchestrator] Vision Path succeeded:`, visionPathResult.actionPayload);
            return visionPathResult;
        }

        console.warn(`[Subphase3Orchestrator] Vision Path failed. Tripping Escalation Circuit Breaker.`);

        // 3. Escalation Matrix (Circuit Breaker)
        return await this._handleEscalation(tabId, step);
    }

    async _runFastPath(tabId, step) {
        try {
            // Extract Pseudo-AXTree from the tab
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    if (!window.ContextExtractor) return null;
                    const mapping = window.ContextExtractor.getElementsForMapping();
                    const fullElements = window.ContextExtractor.getUIElements();
                    const requires_cdp = window.ContextExtractor.extract().requires_cdp;
                    return { mapping, fullElements, requires_cdp };
                }
            });

            if (!results || !results[0] || !results[0].result) {
                return { status: 'FAILED', reason: 'ContextExtractor missing' };
            }

            const { mapping, fullElements, requires_cdp } = results[0].result;
            
            // Ask Groq to find the element
            const idx = await this._queryGroqForElement(mapping, step);
            if (idx === -1 || idx === '-1') {
                return { status: 'FAILED', reason: 'LLM returned NOT_FOUND' };
            }

            // Find coordinates
            const targetEl = fullElements.find(e => e._idx === parseInt(idx, 10));
            if (!targetEl) {
                return { status: 'FAILED', reason: 'LLM returned invalid ID' };
            }

            return { 
                status: 'SUCCESS', 
                actionPayload: { 
                    type: 'click',
                    x: targetEl.x, 
                    y: targetEl.y, 
                    width: targetEl.width, 
                    height: targetEl.height,
                    requires_cdp: requires_cdp 
                } 
            };
        } catch (e) {
            console.error(`[Subphase3Orchestrator] Fast Path Error:`, e);
            return { status: 'FAILED', reason: e.message };
        }
    }

    async _queryGroqForElement(mapping, step) {
        const historyText = this._buildThoughtContext(step);
        
        const prompt = `
You are a Grounding Agent. Your job is to map an intended action to an element in the provided UI Tree.
Action: "${step.action} on ${step.target}"${historyText}
Return ONLY a JSON object with the key "idx" pointing to the target element's idx.
If not found, return {"idx": -1}.

UI Tree:
${JSON.stringify(mapping, null, 2)}
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
            return result.idx;
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
            if (content.startsWith('```json')) content = content.replace(/```json/g, '').replace(/```/g, '').trim();
            const result = JSON.parse(content);
            return result.idx;
        };

        try {
            return await fetchFromGroq();
        } catch (e) {
            console.warn("[Subphase3Orchestrator] Groq Fast Path failed. Retrying with Gemini Flash Fallback...", e);
            try {
                return await fetchFromOpenRouter();
            } catch (fallbackError) {
                console.error("[Subphase3Orchestrator] Fast Path Fallback query failed:", fallbackError);
                return -1;
            }
        }
    }

    async _runVisionPath(tabId, step) {
        try {
            // 1. Capture Visible Tab
            const tab = await chrome.tabs.get(tabId);
            const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 50 });
            
            // 2. TipTour-style Client-Side Downscaling (Canvas)
            const scaledScreenshot = await this._downscaleImage(tabId, screenshotDataUrl);

            // 3. Query OpenRouter / ByteDance UI-TARS
            const coords = await this._queryUITars(scaledScreenshot, step);
            if (!coords) return { status: 'FAILED', reason: 'Vision LLM failed to locate target' };

            // 4. Remap Coordinates (UI-TARS returns [x, y] in 1000x1000 grid)
            const viewport = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => ({ w: window.innerWidth, h: window.innerHeight })
            });
            const { w, h } = viewport[0].result;

            const realX = (coords[0] / 1000) * w;
            const realY = (coords[1] / 1000) * h;

            if (realY > h || realY < 0 || realX > w || realX < 0) {
                return { status: 'FAILED', reason: 'Target is off-screen' };
            }

            return { 
                status: 'SUCCESS', 
                actionPayload: { 
                    type: 'click',
                    x: realX, 
                    y: realY, 
                    width: 10, 
                    height: 10,
                    requires_cdp: true, // Vision path always requires CDP to click physical coordinates
                    rawUITarsCoords: coords
                } 
            };
        } catch (e) {
            console.error(`[Subphase3Orchestrator] Vision Path Error:`, e);
            return { status: 'FAILED', reason: e.message };
        }
    }

    async _downscaleImage(tabId, dataUrl) {
        // Execute canvas downscaling inside the tab to leverage DOM Image API
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (url) => {
                return new Promise((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        // TipTour scaling factor: max 1024 width
                        const scale = Math.min(1024 / img.width, 1);
                        canvas.width = img.width * scale;
                        canvas.height = img.height * scale;
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL('image/jpeg', 0.6));
                    };
                    img.src = url;
                });
            },
            args: [dataUrl]
        });
        return results[0].result;
    }
    _validateXMLSchema(content) {
        // Find the action tag directly
        const actionMatch = content.match(/<action>\s*([\[\(][^\]\)]+[\]\)])\s*<\/action>/i);
        
        if (!actionMatch || !actionMatch[1]) {
            throw new Error(`Invalid XML schema: Missing or malformed <action> tags. Raw content: ${content.substring(0, 100)}...`);
        }
        
        // Log a warning if the thought block or pillars are missing, but don't crash
        if (!content.match(/<thought>([\s\S]*?)<\/thought>/i)) {
            console.warn(`[Subphase3Orchestrator] Vision Model returned <action> but no <thought> block.`);
        } else if (!content.includes('<decomposition>')) {
            console.warn(`[Subphase3Orchestrator] Vision Model omitted <decomposition> pillar, but <action> was recovered.`);
        }

        return actionMatch[1].trim();
    }

    _buildThoughtContext(step) {
        if (!step.history || step.history.length === 0) return '';
        
        let contextBuilder = `\nRecent Action History Queue:\n`;
        step.history.forEach((h, index) => {
            contextBuilder += `[Attempt ${index + 1}] Target: ${h.step} | Status: ${h.status} | Coords: ${h.coords || 'N/A'}\n`;
            if (h.reason) {
                contextBuilder += `   -> ${h.reason}\n`;
            }
        });
        return contextBuilder;
    }

    async _queryUITars(base64Image, step) {
        try {
            console.log(`[Subphase3Orchestrator] Sending to Vision Model: ${config.VISION_MODEL_UITARS}`);
            
            if (!config.OPENROUTER_API_KEY || config.OPENROUTER_API_KEY === 'insert_key_here') {
                throw new Error('OpenRouter API Key is missing');
            }

            const historyText = this._buildThoughtContext(step);

            const prompt = `Locate the UI element: "${step.action} on ${step.target}".${historyText}
You must think step-by-step.
Output your response EXACTLY in this XML format:
<thought>
  <decomposition>What is the immediate sub-step?</decomposition>
  <history_check>Am I stuck in a loop?</history_check>
  <milestone>Did the previous action succeed visually?</milestone>
  <hypothesis>Describe the exact visual characteristics (color, text) of the target. If none, output NOT_FOUND.</hypothesis>
  <reflection>If the last action failed, why? What is the new strategy?</reflection>
</thought>
<action>[x, y]</action>`;

            const response = await fetch(config.OPENROUTER_PROVIDER_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://follome.app',
                    'X-Title': 'FolloMe'
                },
                body: JSON.stringify({
                    model: config.VISION_MODEL_UITARS,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: base64Image } }
                        ]
                    }],
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`OpenRouter API failed: ${err}`);
            }

            const data = await response.json();
            let content = data.choices[0].message.content.trim();
            
            // Strict XML Validation (No Fallbacks)
            let coordsRaw = this._validateXMLSchema(content);
            
            if (coordsRaw.startsWith('(') && coordsRaw.endsWith(')')) {
                coordsRaw = '[' + coordsRaw.slice(1, -1) + ']';
            }
            
            const coords = JSON.parse(coordsRaw);

            if (Array.isArray(coords) && coords.length === 2) {
                return coords;
            } else if (coords.x !== undefined && coords.y !== undefined) {
                return [coords.x, coords.y];
            }
            
            throw new Error(`Invalid coordinate schema returned in <action>: ${coordsRaw}`);
        } catch(e) {
            console.error(`[Subphase3Orchestrator] Vision API Error:`, e);
            return null;
        }
    }

    async _handleEscalation(tabId, step) {
        let attempts = this.scrollAttempts.get(tabId) || 0;
        attempts++;
        this.scrollAttempts.set(tabId, attempts);

        if (attempts >= 2) {
            console.warn(`[Subphase3Orchestrator] Breaker Tripped! Escalating to ChatGPT.`);
            this._injectClarificationPrompt(tabId, step); // fire and forget
            return { status: 'ESCALATED', reason: 'Target not found after scrolling' };
        }

        console.log(`[Subphase3Orchestrator] Scrolling down (Attempt ${attempts})...`);
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => window.scrollBy({ top: window.innerHeight * 0.6, behavior: 'smooth' })
        });

        // Wait for scroll & mutations
        await new Promise(r => setTimeout(r, 1500));
        
        // Retry Pipeline
        return this.executeStep(tabId, step);
    }

    async _injectClarificationPrompt(sourceTabId, step) {
        try {
            const tab = await chrome.tabs.get(sourceTabId);
            const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 50 });

            chrome.tabs.query({}, function(tabs) {
                const aiTab = tabs.find(t => t.url && (t.url.includes('chatgpt.com') || t.url.includes('chat.openai.com') || t.url.includes('gemini.google.com') || t.url.includes('claude.ai')));
                if (aiTab) {
                    const truncatedTarget = step.target && step.target.length > 80 
                        ? step.target.substring(0, 80) + '...' 
                        : step.target;
                    
                    let hasPriorClarification = false;
                    if (step.history && Array.isArray(step.history)) {
                        hasPriorClarification = step.history.some(h => h.status === 'TEACHER_CLARIFICATION');
                    }
                    
                    let promptMessage = `I am trying to execute the action: '${step.action} on ${truncatedTarget}'. However, I cannot find the corresponding UI element on the screen. Can you clarify which specific element I should interact with?`;
                    if (hasPriorClarification) {
                        promptMessage = `I tried following your previous instructions to interact with '${truncatedTarget}', but I am still unable to find the correct element or the action did not work. Please review this new screenshot of my current screen. Did the screen change? Did I do something wrong? What is my exact next step?`;
                    }

                    chrome.tabs.sendMessage(aiTab.id, {
                        type: 'TRIGGER_CLARIFICATION',
                        message: promptMessage,
                        screenshot: screenshotDataUrl,
                        sourceTabId: sourceTabId
                    });
                }
            });
        } catch (e) {
            console.error("[Subphase3Orchestrator] Failed to capture screenshot for clarification", e);
        }
    }
}
