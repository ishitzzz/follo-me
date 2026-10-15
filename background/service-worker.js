/**
 * FolloMe — Background Service Worker
 * Unified Architecture (Phase 1)
 * Handles Lyto-style memory, Offscreen LLM routing, and Hybrid Execution.
 */
import '../utils/telemetry-client.js';

import { SessionManager } from '../brain/session-manager.js';
import { HybridExecutor } from '../brain/hybrid-executor.js';
import { GhostScoutOrchestrator } from './GhostScoutOrchestrator.js';

import { executeStateMachine } from './state-machine-controller.js';
import { ReactAgent } from './agents/ReactAgent.js';

// 1. Initialize Global Session Memory
const sessionManager = new SessionManager();
sessionManager.initializeListeners();

// 2. Initialize Hybrid Executor & Multi-Agent Planner
const hybridExecutor = new HybridExecutor();
const ghostScoutOrchestrator = new GhostScoutOrchestrator();


let activeReactAgent = null;

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
        
        activeReactAgent = new ReactAgent(sender.tab?.id, message.payload);
        activeReactAgent.start();
        
        sendResponse({ status: 'pipeline_complete' });
        return true; // Keep message channel open for async response
    }

    if (message.type === 'TEACHER_RESPONSE') {
        console.log("[ServiceWorker] Received TEACHER_RESPONSE:", message.response);
        if (activeReactAgent) {
            activeReactAgent.memory.addUserMessage(`Teacher AI says: ${message.response}`);
            if (!activeReactAgent.isRunning) {
                activeReactAgent.start();
            }
        }
        sendResponse({ status: 'teacher_response_handled' });
        return true;
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

// Phase 1.3: Cross-Tab Resilience
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
    if (activeReactAgent && activeReactAgent.tabId === details.sourceTabId) {
        console.log(`[ServiceWorker] New tab spawned by click. Migrating agent from ${details.sourceTabId} to tab ${details.tabId}`);
        await activeReactAgent.updateTabId(details.tabId);
    }
});

