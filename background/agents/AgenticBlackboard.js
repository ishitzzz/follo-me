export class AgenticBlackboard {
    constructor(rawIntent, activeUrl) {
        this.rawIntent = rawIntent;
        this.activeUrl = activeUrl;
        
        // Agent 1 output
        this.triagedIntent = null; 
        
        // Agent 2 output
        this.structuredPlan = null;
        
        // Agent 3 output
        this.clarificationAnswers = [];
        
        // Agent 4 output
        this.targetUrl = null;

        // Routing state
        this.status = 'PENDING'; // PENDING, LOCAL_EXECUTION, CHATGPT_ESCALATION, READY_FOR_NAVIGATION, REJECTED
        this.pendingQuestion = null;
    }

    // Getters and setters to enforce structural integrity
    setTriagedIntent(intentType) {
        this.triagedIntent = intentType;
    }

    setStructuredPlan(plan) {
        this.structuredPlan = plan;
    }

    addClarification(question, answer) {
        this.clarificationAnswers.push({ question, answer });
    }

    setTargetUrl(url) {
        this.targetUrl = url;
    }

    setStatus(status) {
        this.status = status;
    }

    serialize() {
        return {
            rawIntent: this.rawIntent,
            activeUrl: this.activeUrl,
            triagedIntent: this.triagedIntent,
            structuredPlan: this.structuredPlan,
            clarificationAnswers: this.clarificationAnswers,
            targetUrl: this.targetUrl,
            status: this.status,
            timestamp: Date.now()
        };
    }
}
