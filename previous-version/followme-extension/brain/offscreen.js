import { config } from '../config.js';

console.log("Offscreen Brain Initialized");

// Listen for messages from the Service Worker (background.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'EVALUATE_DOM') {
        const domTree = message.domTree;
        const task = message.task;
        
        console.log(`Offscreen Brain received task: ${task}`);
        
        // Ensure async operation keeps port open
        evaluateWithLLM(domTree, task)
            .then(jsonPlan => {
                sendResponse({ status: 'success', plan: jsonPlan });
            })
            .catch(err => {
                console.error("Offscreen Brain Error:", err);
                sendResponse({ status: 'error', error: err.message });
            });
            
        return true; // Indicates asynchronous response
    }
});

async function evaluateWithLLM(domTree, task) {
    const prompt = `
    You are an autonomous web agent.
    Goal: ${task}
    DOM Tree:
    ${JSON.stringify(domTree)}
    
    Output ONLY valid JSON specifying the next action. Example:
    { "action": "click", "elementId": "submit-btn" }
    `;

    const response = await fetch(config.LLAMA_PROVIDER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLAMA_API_KEY}`
        },
        body: JSON.stringify({
            model: config.FAST_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        throw new Error(`LLM API Error: ${response.statusText}`);
    }

    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
}
