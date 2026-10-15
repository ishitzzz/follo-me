import { config } from '../../config.js';

export class TriagingAgent {
    constructor() {
        this.apiKey = config.LLAMA_API_KEY;
        this.apiUrl = config.LLAMA_PROVIDER_URL;
        this.model = config.FAST_MODEL;
    }

    /**
     * @param {AgenticBlackboard} blackboard 
     * @returns {Promise<string>} Next Agent routing command: 'LOCAL', 'PLAN', 'ESCALATE', 'REJECT'
     */
    async execute(blackboard) {
        if (!this.apiKey || this.apiKey === 'insert_key_here') {
            console.warn("[TriagingAgent] No Groq API Key. Mocking PLAN.");
            blackboard.setTriagedIntent('PLAN');
            return 'PLAN';
        }

        const prompt = `
Identity: You are FolloMe, a web browser agent designed to guide users via UI tooltips or execute autonomous web tasks.
Capabilities: You CAN click, scroll, navigate, and read public DOM state.
Hard Boundaries: You CANNOT and WILL NOT attempt to type passwords, perform user logins, solve CAPTCHAs, or input personal information unless explicitly provided in the request (e.g. "enter John Doe").

Task: Analyze the user's intent: "${blackboard.rawIntent}"
Route it to one of these outputs EXACTLY:
- REJECT: If it violates Hard Boundaries (e.g., asking to login).
- LOCAL: If it's a simple single action (e.g., "click submit", "scroll down").
- PLAN: If it's a multi-step workflow across pages (e.g., "go to amazon and buy shoes").
- ESCALATE: If it requires external knowledge (e.g., "what's the best flight to Paris?").

Output ONLY the exact routing word.
`;
        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: 'system', content: prompt }],
                    temperature: 0.1,
                    max_tokens: 10
                })
            });

            if (!response.ok) throw new Error("Triaging API failed");
            
            const data = await response.json();
            let route = data.choices[0].message.content.trim().toUpperCase();
            
            // Clean up common LLM artifacts
            if (route.includes('REJECT')) route = 'REJECT';
            else if (route.includes('LOCAL')) route = 'LOCAL';
            else if (route.includes('ESCALATE')) route = 'ESCALATE';
            else route = 'PLAN';
            
            blackboard.setTriagedIntent(route);
            return route;

        } catch (e) {
            console.error("[TriagingAgent] Error:", e);
            blackboard.setTriagedIntent('PLAN'); // fallback
            return 'PLAN';
        }
    }
}
