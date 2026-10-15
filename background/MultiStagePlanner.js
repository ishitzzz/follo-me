import { AgenticBlackboard } from './agents/AgenticBlackboard.js';
import { TriagingAgent } from './agents/TriagingAgent.js';
import { StructuringAgent } from './agents/StructuringAgent.js';
import { ClarificationAgent } from './agents/ClarificationAgent.js';
import { NavigationAgent } from './agents/NavigationAgent.js';

export class MultiStagePlanner {
    constructor() {
        this.triagingAgent = new TriagingAgent();
        this.structuringAgent = new StructuringAgent();
        this.clarificationAgent = new ClarificationAgent();
        this.navigationAgent = new NavigationAgent();
    }

    /**
     * Executes the true Graph-based State Machine for Subphase 1 using pure async/await.
     * @param {string} rawIntent 
     * @param {string} activeUrl 
     */
    async planWorkflow(rawIntent, activeUrl) {
        console.log("[MultiStagePlanner] Starting planning pipeline for intent:", rawIntent);
        const blackboard = new AgenticBlackboard(rawIntent, activeUrl);

        let currentNode = 'TRIAGE';

        // The pure async/await Graph Orchestration Loop
        while (currentNode !== 'DONE' && currentNode !== 'ERROR') {
            switch (currentNode) {
                case 'TRIAGE': {
                    const triageRoute = await this.triagingAgent.execute(blackboard);
                    if (triageRoute === 'REJECT') {
                        blackboard.setStatus('REJECTED');
                        currentNode = 'DONE';
                    } else if (triageRoute === 'LOCAL') {
                        blackboard.setStatus('LOCAL_EXECUTION');
                        blackboard.setTargetUrl(activeUrl);
                        currentNode = 'DONE';
                    } else if (triageRoute === 'ESCALATE') {
                        blackboard.setStatus('CHATGPT_ESCALATION');
                        currentNode = 'DONE'; // Escalate immediately
                    } else {
                        currentNode = 'STRUCTURE'; // Default to planning
                    }
                    break;
                }

                case 'STRUCTURE': {
                    const structureRoute = await this.structuringAgent.execute(blackboard);
                    if (structureRoute === 'CLARIFY') {
                        currentNode = 'CLARIFY';
                    } else if (structureRoute === 'ERROR') {
                        blackboard.setStatus('ERROR');
                        currentNode = 'ERROR';
                    } else {
                        currentNode = 'NAVIGATE';
                    }
                    break;
                }

                case 'CLARIFY': {
                    const clarifyRoute = await this.clarificationAgent.execute(blackboard);
                    if (clarifyRoute === 'DEADLOCK') {
                        // Force structurer to assume
                        blackboard.addClarification("FORCE", "Make best autonomous assumption.");
                        currentNode = 'STRUCTURE';
                    } else {
                        currentNode = 'STRUCTURE';
                    }
                    break;
                }

                case 'NAVIGATE': {
                    const navRoute = await this.navigationAgent.execute(blackboard);
                    if (navRoute === 'DONE') {
                        blackboard.setStatus('READY_FOR_NAVIGATION');
                        currentNode = 'DONE';
                    } else {
                        currentNode = 'ERROR';
                    }
                    break;
                }

                default: {
                    console.error("[MultiStagePlanner] Unknown node:", currentNode);
                    currentNode = 'ERROR';
                    break;
                }
            }
        }

        console.log("[MultiStagePlanner] Pipeline complete.", blackboard.serialize());
        return blackboard.serialize();
    }
}
