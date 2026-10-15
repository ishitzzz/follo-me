export class ClarificationAgent {
    constructor() {
        this.loopCount = 0;
    }

    /**
     * @param {AgenticBlackboard} blackboard 
     * @returns {Promise<string>} 'REPLAN' or 'DEADLOCK'
     */
    async execute(blackboard) {
        this.loopCount++;
        
        if (this.loopCount >= 2) {
            console.warn("[ClarificationAgent] Max loops reached. Deadlock resolution.");
            return 'DEADLOCK';
        }

        console.log(`[ClarificationAgent] Escaping to ChatGPT for: ${blackboard.pendingQuestion}`);
        
        const response = await this.askChatGPT(blackboard.pendingQuestion);
        
        blackboard.addClarification(blackboard.pendingQuestion, response);
        blackboard.pendingQuestion = null;

        return 'REPLAN';
    }

    askChatGPT(question) {
        return new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                const aiTab = tabs.find(t => t.url && (t.url.includes('chatgpt.com') || t.url.includes('chat.openai.com') || t.url.includes('gemini.google.com') || t.url.includes('claude.ai')));
                
                if (aiTab) {
                    const listener = (message) => {
                        if (message.type === 'TEACHER_RESPONSE') {
                            chrome.runtime.onMessage.removeListener(listener);
                            resolve(message.response);
                        }
                    };
                    chrome.runtime.onMessage.addListener(listener);
                    
                    chrome.tabs.sendMessage(aiTab.id, {
                        type: 'INJECT_PROMPT',
                        prompt: question,
                        sourceTabId: null // We could track sourceTabId via blackboard if needed, but null works for background tasks
                    });
                } else {
                    resolve("No AI tab found. Making best autonomous assumption based on context.");
                }
            });
        });
    }
}
