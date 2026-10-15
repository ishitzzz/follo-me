export class MemoryManager {
  constructor(systemPrompt) {
    this.history = [];
    
    // Add the system prompt first.
    // In OpenRouter/DeepInfra, keeping this static at the top allows prompt caching.
    this.history.push({
      role: 'system',
      content: systemPrompt
    });
  }

  addUserMessage(content) {
    this.history.push({
      role: 'user',
      content: content
    });
  }

  addAssistantMessage(content, toolCalls = null) {
    const message = { role: 'assistant' };
    if (content) message.content = content;
    if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls;
    
    this.history.push(message);
  }

  addToolResponse(toolCallId, name, content) {
    this.history.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name: name,
      content: content
    });
  }

  getMessages() {
    return this.history;
  }

  pruneHistoryIfNeeded(maxTokens = 16000) {
    // Basic context window management. 
    // In a production ReAct loop, we might want to slice older messages 
    // while keeping the system prompt intact.
    // For now, this is a placeholder. Prompt caching handles large histories efficiently.
    if (this.history.length > 50) {
      console.warn('[MemoryManager] History is getting long. Consider pruning.');
      // Keep system prompt (index 0) and the last 30 messages
      this.history = [this.history[0], ...this.history.slice(-30)];
    }
  }
}
