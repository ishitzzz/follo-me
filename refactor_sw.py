import re

with open("background/service-worker.js", "r") as f:
    content = f.read()

# Extract the execution logic
start_idx = content.find('multiStagePlanner.planWorkflow(message.payload, activeUrl).then(result => {')
end_idx = content.find('return true; // Keep message channel open for async response\n    }\n\n\n\n    // Phase 2: Cursor UI Messages')

extracted_logic = content[start_idx:end_idx]
extracted_logic = extracted_logic.replace('message.payload', 'intentPayload')
extracted_logic = extracted_logic.replace('sender.tab?.id', 'senderTabId')

helper_function = f"""
function executeAgentPipeline(intentPayload, senderTabId, sendResponse) {{
    chrome.tabs.query({{active: true, currentWindow: true}}, function(tabs) {{
        const activeUrl = tabs[0] ? tabs[0].url : "https://google.com";
        
        {extracted_logic.replace('            multiStage', '        multiStage').strip()}
}}
"""

new_handlers = """
    // Phase 3: The Multi-Agent Orchestration Pipeline
    if (message.type === 'START_AGENT_PIPELINE') {
        console.log("[ServiceWorker] Starting Agentic Pipeline for intent:", message.payload);
        sessionManager.summarizeContext(message.payload, null);
        executeAgentPipeline(message.payload, sender.tab?.id, sendResponse);
        return true;
    }

    // Phase 3: Teacher Response Loop Closure
    if (message.type === 'TEACHER_RESPONSE') {
        console.log("[ServiceWorker] Received TEACHER_RESPONSE from", message.platform, ":", message.response);
        const augmentedIntent = sessionManager.summarizeContext(null, message.response);
        
        // Feed the augmented intent back into the Multi-Stage Planner
        executeAgentPipeline(augmentedIntent, sender.tab?.id, sendResponse);
        return true;
    }
"""

# Now replace the old START_AGENT_PIPELINE block
full_old_block_start = content.find('// Phase 3: The Multi-Agent Orchestration Pipeline')
full_old_block_end = end_idx + len('return true; // Keep message channel open for async response\n    }\n')

new_content = content[:full_old_block_start] + new_handlers + "\n" + content[full_old_block_end:] + "\n" + helper_function

with open("background/service-worker.js", "w") as f:
    f.write(new_content)

print("Refactored service-worker.js")
