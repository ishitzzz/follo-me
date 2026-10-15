export const ToolSchemas = [
  {
    type: "function",
    function: {
      name: "click_element",
      description: "Clicks on an interactive element on the page using its follo-id.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The data-follo-id of the element to click."
          }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Types text into an input field using its follo-id.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The data-follo-id of the input element."
          },
          text: {
            type: "string",
            description: "The text to type into the field."
          }
        },
        required: ["id", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "hover_element",
      description: "Hovers over an element to reveal dropdowns or submenus.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The data-follo-id of the element to hover over."
          }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scrolls the page to reveal more elements.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down"],
            description: "The direction to scroll."
          }
        },
        required: ["direction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "consult_teacher_ai",
      description: "Ask a smarter teacher AI for strategic advice when you are stuck, confused, or don't know what to do next on the current page.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The question or context you want to ask the teacher AI."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "use_vision",
      description: "Use a vision model to find coordinates on the screen when the DOM is obscured or the element lacks an ID.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What element should the vision model look for?"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "task_complete",
      description: "Call this when the user's intent has been fully achieved.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }
];

export class ToolExecutor {
  constructor(tabId) {
    this.tabId = tabId;
  }

  async execute(functionName, args) {
    console.log(`[ToolExecutor] Executing ${functionName} with args:`, args);
    
    switch (functionName) {
      case 'click_element':
      case 'type_text':
      case 'hover_element':
      case 'scroll':
        // Forward DOM interactions to the content script
        return await this._sendToTab(functionName, args);
        
      case 'consult_teacher_ai':
        return await this._consultTeacherAI(args.query);
        
      case 'use_vision':
        return await this._useVision(args.query);
        
      case 'task_complete':
        return { result: "Task successfully marked as complete. Stop reasoning and end the loop." };
        
      default:
        throw new Error(`Unknown tool: ${functionName}`);
    }
  }

  async _sendToTab(action, args) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(this.tabId, { type: 'EXECUTE_TOOL', action, args }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ result: `Error executing tool: ${chrome.runtime.lastError.message}` });
        } else {
          resolve(response || { result: "Tool executed successfully (no specific return value)." });
        }
      });
    });
  }

  async _consultTeacherAI(query) {
    // This will hit the ChatGPT API (or whatever is configured for the teacher AI).
    // For now, we will simulate the integration. In the actual ReAct loop, 
    // the agent receives this text as a tool_response.
    return { result: "I am the Teacher AI. I received your query: " + query + ". (TODO: Hook up ChatGPT API here)" };
  }

  async _useVision(query) {
    // This will hit the UI-TARS vision model.
    return { result: "Vision model analyzed the screen for: " + query + ". (TODO: Hook up UI-TARS API here)" };
  }
}
