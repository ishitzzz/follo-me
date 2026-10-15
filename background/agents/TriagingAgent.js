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
Identity: You are FolloMe's Triage & Routing Agent (powered by Groq).
Capabilities: You CAN click, scroll, navigate, and read public DOM state.
Hard Boundaries: You CANNOT and WILL NOT attempt to type passwords, perform user logins, solve CAPTCHAs, or input personal information unless explicitly provided in the request (e.g. "enter John Doe").

You are analyzing an intent which may include a recent conversational summary and a response from a "Teacher" LLM (ChatGPT/Gemini/Claude).

Intent context:
"${blackboard.rawIntent}"

Your job is to route this to one of the following exact outputs:
1. REJECT: If the request violates Hard Boundaries (e.g., asking to login).
2. LOCAL: If it's a simple single action (e.g., "click submit", "scroll down") and doesn't need planning.
3. PLAN: If it's a multi-step workflow OR if the Teacher LLM provided a set of instructions/solutions that can now be executed.
4. ESCALATE: If it requires external knowledge that hasn't been provided yet (e.g., "what's the best flight to Paris?").
5. ANSWER_TEACHER: <your answer here> - Use this IF the Teacher LLM asks a clarifying question (e.g. "Do you want one-way or round trip?") AND you can deduce the answer from the historical context.
6. CLARIFY_USER: Use this IF the Teacher LLM asks a question and the answer is NOT present in the historical context.

Output ONLY the exact routing word (or ANSWER_TEACHER: <answer>).
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
                    max_tokens: 150
                })
            });

            if (!response.ok) throw new Error("Triaging API failed");
            
            const data = await response.json();
            let route = data.choices[0].message.content.trim();
            
            // Clean up common LLM artifacts
            const upperRoute = route.toUpperCase();
            if (upperRoute.startsWith('ANSWER_TEACHER')) {
                // Return the full string so MultiStagePlanner can extract the answer
                blackboard.setTriagedIntent(route);
                return route;
            } else if (upperRoute.includes('CLARIFY_USER')) {
                route = 'CLARIFY_USER';
            } else if (upperRoute.includes('REJECT')) {
                route = 'REJECT';
            } else if (upperRoute.includes('LOCAL')) {
                route = 'LOCAL';
            } else if (upperRoute.includes('ESCALATE')) {
                route = 'ESCALATE';
            } else {
                route = 'PLAN';
            }
            
            blackboard.setTriagedIntent(route);
            return route;

        } catch (e) {
            console.error("[TriagingAgent] Error:", e);
            blackboard.setTriagedIntent('PLAN'); // fallback
            return 'PLAN';
        }
    }
}
