import { config } from '../../config.js';

export class NavigationAgent {
    constructor() {
        this.apiKey = config.LLAMA_API_KEY;
        this.apiUrl = config.LLAMA_PROVIDER_URL;
        this.model = config.FAST_MODEL;
    }

    /**
     * @param {AgenticBlackboard} blackboard 
     * @returns {Promise<string>} 'DONE' or 'ERROR'
     */
    async execute(blackboard) {
        try {
            const plan = blackboard.structuredPlan;
            if (!plan || !Array.isArray(plan) || plan.length === 0) {
                console.warn("[NavigationAgent] No structured plan found. Defaulting to active URL.");
                blackboard.setTargetUrl(blackboard.activeUrl || "https://google.com");
                return 'DONE';
            }

            // Get domain from the first block of the plan
            let rawDomain = plan[0].domain;
            
            if (!rawDomain || rawDomain.toLowerCase() === 'mock') {
                blackboard.setTargetUrl(blackboard.activeUrl || "https://google.com");
                return 'DONE';
            }

            let targetUrl = this.sanitizeUrl(rawDomain);
            blackboard.setTargetUrl(targetUrl);
            
            console.log(`[NavigationAgent] Resolved target URL: ${targetUrl}`);
            return 'DONE';
        } catch (e) {
            console.error("[NavigationAgent] Error:", e);
            blackboard.setTargetUrl(blackboard.activeUrl || "https://google.com");
            return 'ERROR';
        }
    }

    sanitizeUrl(domain) {
        let url = domain.trim();
        // If it looks like a search query rather than a domain, we could query an LLM or default to Google Search
        if (!url.includes('.')) {
            return `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        }
        
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        return url;
    }
}
