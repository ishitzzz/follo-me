/**
 * FolloMe — Background Service Worker
 * Unified Architecture (Phase 1)
 * Handles Lyto-style memory, Offscreen LLM routing, and Hybrid Execution.
 */
import '../utils/telemetry-client.js';

import { SessionManager } from '../brain/session-manager.js';
import { HybridExecutor } from '../brain/hybrid-executor.js';
import { MultiStagePlanner } from './MultiStagePlanner.js';
import { GhostScoutOrchestrator } from './GhostScoutOrchestrator.js';
import { Subphase3Orchestrator } from './Subphase3Orchestrator.js';

// 1. Initialize Global Session Memory
const sessionManager = new SessionManager();
sessionManager.initializeListeners();

// 2. Initialize Hybrid Executor & Multi-Agent Planner
const hybridExecutor = new HybridExecutor();
const multiStagePlanner = new MultiStagePlanner();
const ghostScoutOrchestrator = new GhostScoutOrchestrator();
const subphase3Orchestrator = new Subphase3Orchestrator();

// 3. Start Memory Heartbeat
setInterval(() => {
    sessionManager.refreshSnapshot();
}, 30000);

// 4. Boot Offscreen Brain
async function setupOffscreenDocument(path) {
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenDocument = existingContexts.find(c => c.contextType === 'OFFSCREEN_DOCUMENT');
    if (!offscreenDocument) {
        await chrome.offscreen.createDocument({
            url: path,
            reasons: ['DOM_PARSER'],
            justification: 'Running background LLM inference and parsing'
        });
    }
}
setupOffscreenDocument('views/offscreen.html');

// 5. Central Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PAGE_READY') {
        console.log("[ServiceWorker] Content script loaded on tab", sender.tab?.id);
        sendResponse({ status: 'acknowledged' });
    }
    
    if (message.type === 'HEARTBEAT') {
        sendResponse({ status: 'alive' });
    }

    // New DOM_EXTRACTED flow from the Host Page
    if (message.type === 'DOM_EXTRACTED') {
        console.log("[ServiceWorker] Received DOM Context. Forwarding to Offscreen Brain...");
        
        // Pass to offscreen brain
        chrome.runtime.sendMessage({
            action: 'EVALUATE_DOM',
            domTree: message.domTree,
            task: sessionManager.currentSnapshot.agentTask || 'Explore the page'
        }).then(response => {
            if (response && response.status === 'success') {
                console.log("[ServiceWorker] Received Execution Plan:", response.plan);
                
                // Execute plan via Hybrid Executor
                if (response.plan.action === 'click') {
                    hybridExecutor.execute(sender.tab.id, response.plan, message.requires_cdp);
                }
            } else {
                console.error("[ServiceWorker] Offscreen Brain evaluation failed", response?.error);
            }
        });
        
        sendResponse({ status: 'processing' });
    }

    // Phase 2: Conversational Watcher Messages
    if (message.type === 'ARM_EXTENSION') {
        console.log("[ServiceWorker] Extension Armed locally.");
        sessionManager.updateContext({ isArmed: true });
        sendResponse({ status: 'armed' });
    }

    // Phase 3: The Multi-Agent Orchestration Pipeline
    if (message.type === 'START_AGENT_PIPELINE') {
        console.log("[ServiceWorker] Starting Agentic Pipeline for intent:", message.payload);
        
        // Find active tab to pass active URL to the planner
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            const activeUrl = tabs[0] ? tabs[0].url : "https://google.com";
            
            multiStagePlanner.planWorkflow(message.payload, activeUrl).then(result => {
                // Save the final blackboard serialization into session manager
                sessionManager.updateContext({ folloMeActivePlan: result });
                console.log("[ServiceWorker] Pipeline finished and saved to storage.");
                
                if (result.status === 'CHATGPT_ESCALATION') {
                    chrome.tabs.query({}, function(tabs) {
                        const aiTab = tabs.find(t => t.url && (t.url.includes('chatgpt.com') || t.url.includes('chat.openai.com') || t.url.includes('gemini.google.com') || t.url.includes('claude.ai')));
                        if (aiTab) {
                            chrome.tabs.sendMessage(aiTab.id, {
                                type: 'INJECT_PROMPT',
                                prompt: message.payload,
                                sourceTabId: sender.tab?.id
                            });
                        }
                    });
                } else if (result.status === 'REJECTED') {
                    if (sender.tab?.id) {
                        chrome.tabs.sendMessage(sender.tab.id, {
                            type: 'SHOW_ERROR',
                            error: 'FolloMe cannot perform this task due to security boundaries.'
                        });
                    }
                } else if (result.status === 'READY_FOR_NAVIGATION' || result.status === 'LOCAL_EXECUTION') {
                    if (result.targetUrl) {
                        ghostScoutOrchestrator.manageTab(result.targetUrl).then((tabId) => {
                            console.log("[ServiceWorker] Subphase 2 Ghost Scout settled. Tab ID:", tabId);
                            sessionManager.updateContext({ ghostScoutTabId: tabId });
                            
                            // Hand off to Subphase 3 execution loop
                            let planSteps = [];
                            if (result.structuredPlan && Array.isArray(result.structuredPlan)) {
                                result.structuredPlan.forEach(domainPlan => {
                                    if (Array.isArray(domainPlan.steps)) {
                                        domainPlan.steps.forEach(stepItem => {
                                            const stepDesc = typeof stepItem === 'string' ? stepItem : JSON.stringify(stepItem);
                                            planSteps.push({ action: "Interact with", target: stepDesc });
                                        });
                                    }
                                });
                            }
                            
                            if (planSteps.length === 0) {
                                console.warn("[ServiceWorker] No actionable steps parsed from structuredPlan. Halting execution.");
                                sendResponse({ status: 'pipeline_complete', result, execution: 'halted_no_steps' });
                                return;
                            }
                            
                            async function executeStateMachine(tabId, steps) {
                                let actionHistory = [];
                                for (let i = 0; i < steps.length; i++) {
                                    let currentStep = steps[i];
                                    let state = 'EVALUATE';
                                    let stepSuccess = false;
                                    let retries = 0;
                                    const maxRetries = 3;
                                    
                                    while (state !== 'DONE' && state !== 'ERROR' && retries < maxRetries) {
                                        if (state === 'EVALUATE') {
                                            console.log(`[StateMachine] EVALUATE step ${i + 1}/${steps.length}:`, currentStep);
                                            // Pass history to orchestrator
                                            currentStep.history = actionHistory;
                                            
                                            try {
                                                const evalResult = await subphase3Orchestrator.executeStep(tabId, currentStep);
                                                if (evalResult && evalResult.status === 'SUCCESS') {
                                                    currentStep.actionPayload = evalResult.actionPayload;
                                                    state = 'SNAP';
                                                } else if (evalResult && evalResult.status === 'ESCALATED') {
                                                    console.warn(`[StateMachine] EVALUATE returned ESCALATED. Pausing for Teacher AI clarification...`);
                                                    state = 'WAITING_FOR_CLARIFICATION';
                                                } else {
                                                    console.warn(`[StateMachine] EVALUATE failed. Skipping step.`);
                                                    state = 'ERROR';
                                                }
                                            } catch (e) {
                                                console.error("[StateMachine] EVALUATE error:", e);
                                                state = 'ERROR';
                                            }
                                        }
                                        
                                        else if (state === 'WAITING_FOR_CLARIFICATION') {
                                            console.log(`[StateMachine] Waiting for CLARIFICATION_ANSWER...`);
                                            try {
                                                const clarificationAnswer = await new Promise((resolve, reject) => {
                                                    const listener = (msg, sender, sendResponse) => {
                                                        if (msg.type === 'CLARIFICATION_ANSWER') {
                                                            chrome.runtime.onMessage.removeListener(listener);
                                                            sendResponse({status: 'received'});
                                                            resolve(msg.payload);
                                                        }
                                                    };
                                                    chrome.runtime.onMessage.addListener(listener);
                                                    
                                                    // Timeout after 65 seconds
                                                    setTimeout(() => {
                                                        chrome.runtime.onMessage.removeListener(listener);
                                                        reject(new Error("Timeout waiting for clarification"));
                                                    }, 65000);
                                                });
                                                
                                                console.log("[StateMachine] Resuming with clarification:", clarificationAnswer);
                                                
                                                // Inject the answer into the current step history so UI-TARS has context
                                                actionHistory.push({
                                                    step: currentStep.target,
                                                    status: 'TEACHER_CLARIFICATION',
                                                    reason: clarificationAnswer
                                                });
                                                
                                                state = 'EVALUATE';
                                                retries++; // Count this as a retry
                                            } catch (e) {
                                                console.error("[StateMachine] Clarification failed or timed out:", e);
                                                state = 'ERROR';
                                            }
                                        }
                                        
                                        else if (state === 'SNAP') {
                                            console.log(`[StateMachine] SNAP coordinate:`, currentStep.actionPayload);
                                            try {
                                                const snapResponse = await chrome.tabs.sendMessage(tabId, {
                                                    type: 'VERIFY_AND_SNAP',
                                                    payload: { x: currentStep.actionPayload.x, y: currentStep.actionPayload.y }
                                                });
                                                
                                                if (snapResponse && snapResponse.status === 'SUCCESS') {
                                                    currentStep.actionPayload.x = snapResponse.payload.snappedX;
                                                    currentStep.actionPayload.y = snapResponse.payload.snappedY;
                                                    currentStep.actionPayload.width = snapResponse.payload.width;
                                                    currentStep.actionPayload.height = snapResponse.payload.height;
                                                    
                                                    // Now check overlay
                                                    const overlayCheck = await chrome.tabs.sendMessage(tabId, {
                                                        type: 'CHECK_OVERLAY',
                                                        payload: { x: currentStep.actionPayload.x, y: currentStep.actionPayload.y }
                                                    });
                                                    
                                                    if (overlayCheck && overlayCheck.status === 'OVERLAY_DETECTED') {
                                                        console.warn("[StateMachine] OVERLAY_DETECTED! Routing to popup closer...");
                                                        state = 'ERROR'; 
                                                    } else {
                                                        state = 'ACT';
                                                    }
                                                } else {
                                                    console.warn("[StateMachine] SNAP returned HALLUCINATION.");
                                                    currentStep.failedReason = 'HALLUCINATION';
                                                    state = 'REFLECT';
                                                }
                                            } catch(e) {
                                                console.warn("[StateMachine] Content scripts not ready for SNAP.", e);
                                                state = 'ACT'; // Fallback to blind act if content script missing
                                            }
                                        }
                                        
                                        else if (state === 'ACT') {
                                            console.log(`[StateMachine] ACT executing click at:`, currentStep.actionPayload);
                                            
                                            chrome.tabs.sendMessage(tabId, {
                                                type: 'DRAW_TIPTOUR_OVERLAY',
                                                coordinates: currentStep.actionPayload,
                                                instruction: currentStep.action + " " + currentStep.target
                                            }).catch(() => {});
                                            
                                            // PRE-CLICK SNAPSHOT is now handled inside HybridExecutor to avoid execution delay de-sync

                                            await hybridExecutor.execute(tabId, currentStep.actionPayload, currentStep.actionPayload.requires_cdp);
                                            
                                            state = 'WAITING_FOR_DIFF';
                                        }
                                        
                                        else if (state === 'WAITING_FOR_DIFF') {
                                            console.log("[StateMachine] WAITING_FOR_DIFF (3s)...");
                                            await new Promise(r => setTimeout(r, 3000));
                                            
                                            try {
                                                const diff = await chrome.tabs.sendMessage(tabId, { type: 'POST_CLICK_DIFF' });
                                                if (diff && diff.status === 'DUD') {
                                                    console.warn("[StateMachine] DUD CLICK detected!");
                                                    currentStep.failedReason = 'DUD_CLICK';
                                                    state = 'REFLECT';
                                                } else {
                                                    state = 'DONE';
                                                    stepSuccess = true;
                                                }
                                            } catch(e) {
                                                // If diffing fails (e.g. navigation happened), assume success
                                                state = 'DONE';
                                                stepSuccess = true;
                                            }
                                        }
                                        
                                        else if (state === 'REFLECT') {
                                            console.log("[StateMachine] REFLECT handling failure:", currentStep.failedReason);
                                            retries++;
                                            
                                            let coords = 'unknown coordinates';
                                            if (currentStep.actionPayload) {
                                                if (currentStep.actionPayload.rawUITarsCoords) {
                                                    coords = `[${Math.round(currentStep.actionPayload.rawUITarsCoords[0])}, ${Math.round(currentStep.actionPayload.rawUITarsCoords[1])}]`;
                                                } else {
                                                    coords = `[${Math.round(currentStep.actionPayload.x)}, ${Math.round(currentStep.actionPayload.y)}]`;
                                                }
                                            }
                                            actionHistory.push({
                                                step: currentStep.target,
                                                status: 'FAILED',
                                                coords: coords,
                                                reason: `SYSTEM ALERT: Your last click at ${coords} failed due to ${currentStep.failedReason} (e.g. no DOM changes). Reflect on why this failed in your <reflection> block and formulate a new strategy.`
                                            });
                                            state = 'EVALUATE'; // Retry
                                        }
                                    }
                                    
                                    if (stepSuccess) {
                                        let coords = 'unknown coordinates';
                                        if (currentStep.actionPayload) {
                                            if (currentStep.actionPayload.rawUITarsCoords) {
                                                coords = `[${Math.round(currentStep.actionPayload.rawUITarsCoords[0])}, ${Math.round(currentStep.actionPayload.rawUITarsCoords[1])}]`;
                                            } else {
                                                coords = `[${Math.round(currentStep.actionPayload.x)}, ${Math.round(currentStep.actionPayload.y)}]`;
                                            }
                                        }
                                        actionHistory.push({ step: currentStep.target, status: 'SUCCESS', coords: coords });
                                        if (actionHistory.length > 5) actionHistory.shift();
                                    } else {
                                        console.error(`[StateMachine] Step failed after ${maxRetries} retries. Halting pipeline.`);
                                        break;
                                    }
                                }
                                console.log("[StateMachine] Pipeline execution loop finished.");
                            }
                            
                            executeStateMachine(tabId, planSteps);
                        }).catch(e => console.error("GhostScout Error:", e));
                    }
                }

                sendResponse({ status: 'pipeline_complete', result });
            }).catch(err => {
                console.error("[ServiceWorker] Pipeline failed", err);
                sendResponse({ status: 'error', error: err.message });
            });
        });
        
        return true; // Keep message channel open for async response
    }



    // Phase 2: Cursor UI Messages
    if (message.type === 'RELAY_QUERY_TO_LLM') {
        console.log("[ServiceWorker] Relaying query to LLM:", message.query);
        // Find the active AI tab (ChatGPT/Gemini/Claude)
        chrome.tabs.query({}, function(tabs) {
            const aiTab = tabs.find(t => t.url && (t.url.includes('chatgpt.com') || t.url.includes('chat.openai.com') || t.url.includes('gemini.google.com') || t.url.includes('claude.ai')));
            if (aiTab) {
                chrome.tabs.sendMessage(aiTab.id, {
                    type: 'INJECT_PROMPT',
                    prompt: message.query,
                    sourceTabId: sender.tab?.id
                });
            } else {
                console.warn("[ServiceWorker] No AI tab found to relay query.");
            }
        });
        sendResponse({ status: 'relayed' });
    }

    // Phase 2: rrweb Network Idle & Popups
    if (message.type === 'NETWORK_IDLE') {
        console.log("[ServiceWorker] NETWORK_IDLE received.");
        if (sender.tab?.id) ghostScoutOrchestrator.handleNetworkIdle(sender.tab.id);
        hybridExecutor.handleNetworkIdle();
        sendResponse({ status: 'unlocked' });
    }

    if (message.type === 'POPUP_DETECTED') {
        if (sender.tab?.id) {
            ghostScoutOrchestrator.handlePopupDetected(sender.tab.id, message.htmlChunk);
        }
        sendResponse({ status: 'processing_popup' });
    }

    return true; // Keep message channel open for async responses
});

// Clean up memory when extension is suspended
chrome.runtime.onSuspend.addListener(() => {
    sessionManager.saveSnapshot();
});

