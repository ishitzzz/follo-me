import { config } from '../../config.js';

export class StructuringAgent {
    constructor() {
        this.apiKey = config.OPENROUTER_API_KEY || 'insert_key_here'; 
        this.apiUrl = config.OPENROUTER_PROVIDER_URL || "https://openrouter.ai/api/v1/chat/completions";
        this.model = config.PLANNING_MODEL_QWEN || "qwen/qwen-2.5-72b-instruct";
    }

    /**
     * @param {AgenticBlackboard} blackboard 
     * @returns {Promise<string>} 'CLARIFY' or 'NAVIGATE'
     */
    async execute(blackboard) {
        if (!this.apiKey || this.apiKey === 'insert_key_here') {
            console.warn("[StructuringAgent] No API Key. Mocking NAVIGATE.");
            blackboard.setStructuredPlan([{ domain: "mock", steps: ["mock step"] }]);
            return 'NAVIGATE';
        }

        const systemPrompt = `You are a Planning Agent for a web browser automation tool.`;
        const userPrompt = `
Convert this intent into a strict JSON execution plan: "${blackboard.rawIntent}"
Clarifications available: ${JSON.stringify(blackboard.clarificationAnswers)}

Rules:
1. ONLY include tasks that can be executed digitally in a web browser. Completely ignore physical real-world tasks (like "Practice driving" or "Visit the RTO").
2. The "domain" field MUST be a valid web domain or URL (e.g., "parivahan.gov.in" or "https://parivahan.gov.in"). Do not use conceptual names like "Parivahan Services".
3. Each step MUST start with an explicit UI interaction verb (e.g., 'Click', 'Type', 'Hover', 'Select'). Do NOT use abstract verbs like 'Find', 'Interact', or 'Verify'.
4. If the correct domain/URL is completely missing or unknown, or the steps are highly ambiguous, and you have not received clarification yet, output:
{"clarification_needed": true, "question": "your specific question"}

Otherwise, output a strict JSON array of tasks grouped by the valid web domain:
{"plan": [{"domain": "parivahan.gov.in", "steps": ["Click login", "Type 'foo' into form"]}]}
`;
        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://follome.app',
                    'X-Title': 'FolloMe'
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Structuring API failed: HTTP ${response.status} - ${errText}`);
            }

            const data = await response.json();
            
            if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
                console.error("[StructuringAgent] Unexpected API response format:", data);
                throw new Error("Invalid response format from OpenRouter (missing choices).");
            }
            
            let content = data.choices[0].message.content.trim();
            
            // Strip markdown code blocks if the LLM output them
            if (content.startsWith('```json')) {
                content = content.replace(/^```json/, '').replace(/```$/, '').trim();
            } else if (content.startsWith('```')) {
                content = content.replace(/^```/, '').replace(/```$/, '').trim();
            }
            
            const parsed = JSON.parse(content);

            if (parsed.clarification_needed) {
                blackboard.pendingQuestion = parsed.question;
                return 'CLARIFY';
            } else {
                blackboard.setStructuredPlan(parsed.plan);
                return 'NAVIGATE';
            }

        } catch (e) {
            console.error("[StructuringAgent] Error:", e);
            // Pipeline must handle this ERROR so it doesn't navigate on the current tab
            return 'ERROR';
        }
    }
}
