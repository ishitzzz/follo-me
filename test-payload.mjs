import { ReactAgent } from './background/agents/ReactAgent.js';
const agent = new ReactAgent(1, "Test Intent");
agent.memory.addUserMessage("Hello");
const rawPayload = {
    model: "deepseek/deepseek-r1-distill-llama-70b",
    messages: agent.memory.getMessages(),
    tools: [ { type: "function", function: { name: "test", parameters: {} } } ],
    tool_choice: "auto",
    temperature: 0.6
};
const processed = agent._preProcessDeepSeekPayload(rawPayload);
console.log(JSON.stringify(processed, null, 2));
