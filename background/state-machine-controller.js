import { HybridExecutor } from '../brain/hybrid-executor.js';
import { Subphase3Orchestrator } from './Subphase3Orchestrator.js';

const hybridExecutor = new HybridExecutor();
const subphase3Orchestrator = new Subphase3Orchestrator();

export async function executeStateMachine(tabId, steps, initialState = 'EVALUATE', initialPayload = null) {
    let actionHistory = [];
    for (let i = 0; i < steps.length; i++) {
        let currentStep = steps[i];
        let state = i === 0 ? initialState : 'EVALUATE';
        if (i === 0 && initialPayload) {
            currentStep.actionPayload = initialPayload;
        }
        let stepSuccess = false;
        let retries = 0;
        const maxRetries = 3;
        
        while (state !== 'DONE' && state !== 'ERROR') {
            if (state === 'EVALUATE') {
                console.log(`[StateMachine] EVALUATE step ${i + 1}/${steps.length}:`, currentStep);
                
                try {
                    const parsed = JSON.parse(currentStep.target);
                    let actionText = currentStep.action;
                    if (parsed.x !== undefined && parsed.y !== undefined) {
                        currentStep.target = `${actionText} the element at x: ${parsed.x}, y: ${parsed.y}`;
                    } else if (parsed.id) {
                        currentStep.target = `${actionText} the element with id: ${parsed.id}`;
                    } else {
                        currentStep.target = `${actionText} based on ${JSON.stringify(parsed)}`;
                    }
                } catch(e) {
                    // Not JSON, leave it alone
                }
                
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
                
                currentStep.actionPayload.instruction = currentStep.action + " " + currentStep.target;
                
                // PRE-CLICK SNAPSHOT is now handled inside HybridExecutor to avoid execution delay de-sync
                
                try {
                    await hybridExecutor.execute(tabId, currentStep.actionPayload, currentStep.actionPayload.requires_cdp);
                    
                    state = 'WAITING_FOR_DIFF';
                } catch (error) {
                    console.error("[StateMachine] ACT execution failed:", error);
                    currentStep.failedReason = 'EXECUTION_FAILED';
                    state = 'REFLECT';
                }
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
                    } else if (currentStep.actionPayload.x !== undefined && currentStep.actionPayload.y !== undefined) {
                        coords = `[${Math.round(currentStep.actionPayload.x)}, ${Math.round(currentStep.actionPayload.y)}]`;
                    }
                }
                actionHistory.push({
                    step: currentStep.target,
                    status: 'FAILED',
                    coords: coords,
                    reason: `SYSTEM ALERT: Your last click at ${coords} failed due to ${currentStep.failedReason} (e.g. no DOM changes). Reflect on why this failed in your <reflection> block and formulate a new strategy.`
                });
                if (retries >= maxRetries) {
                    state = 'FALLBACK';
                } else {
                    state = 'EVALUATE'; // Retry
                }
            }
            
            else if (state === 'FALLBACK') {
                console.warn(`[StateMachine] Step failed after ${maxRetries} retries. Initiating user fallback...`);
                let coords = currentStep.actionPayload || { x: 500, y: 500 };
                try {
                    const helpResponse = await chrome.tabs.sendMessage(tabId, {
                        type: 'ASK_FOR_HELP',
                        coordinates: coords,
                        instruction: currentStep.instruction || currentStep.target
                    });

                    if (helpResponse && helpResponse.status === 'RESOLVED') {
                        console.log("[StateMachine] User helped! Resuming execution at:", helpResponse.coords);
                        currentStep.actionPayload = { 
                            ...currentStep.actionPayload, 
                            x: helpResponse.coords.x, 
                            y: helpResponse.coords.y,
                            requires_cdp: false // Can use standard DOM click for fallback usually, or preserve
                        };
                        
                        state = 'WAITING_FOR_DIFF';
                    } else {
                        console.error(`[StateMachine] Fallback failed. Halting pipeline.`);
                        state = 'ERROR';
                    }
                } catch (fallbackErr) {
                    console.error(`[StateMachine] Fallback error:`, fallbackErr);
                    state = 'ERROR';
                }
            }
        }
        
        if (stepSuccess) {
            let coords = 'unknown coordinates';
            if (currentStep.actionPayload) {
                if (currentStep.actionPayload.rawUITarsCoords) {
                    coords = `[${Math.round(currentStep.actionPayload.rawUITarsCoords[0])}, ${Math.round(currentStep.actionPayload.rawUITarsCoords[1])}]`;
                } else if (currentStep.actionPayload.x !== undefined && currentStep.actionPayload.y !== undefined) {
                    coords = `[${Math.round(currentStep.actionPayload.x)}, ${Math.round(currentStep.actionPayload.y)}]`;
                }
            }
            actionHistory.push({ step: currentStep.target, status: 'SUCCESS', coords: coords });
            if (actionHistory.length > 5) actionHistory.shift();
        } else {
            console.error(`[StateMachine] Step failed. Halting pipeline.`);
            return false;
        }
    }
    console.log("[StateMachine] Pipeline execution loop finished.");
    return true;
}
