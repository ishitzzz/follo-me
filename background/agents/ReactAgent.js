import { MemoryManager } from './MemoryManager.js';
import { config } from '../../config.js';
import { MultiStagePlanner } from '../MultiStagePlanner.js';
import { GhostScoutOrchestrator } from '../GhostScoutOrchestrator.js';
import { Subphase3Orchestrator } from '../Subphase3Orchestrator.js';
import { HybridExecutor } from '../../brain/hybrid-executor.js';

const SYSTEM_PROMPT = `You are FolloMe, an autonomous web-browsing AI agent operating inside a Google Chrome Extension.
Your core objective is to fulfill the user's intent by navigating websites, reading the screen, and executing actions like clicking and typing.

You have access to 3 core tools to interact with the browser:
1. 'plan_workflow': Use this FIRST if the user gives a complex intent (e.g., "book a flight" or "apply for a license"). It will break the task down into a structured plan of sub-tasks.
2. 'scout_url': Use this to navigate to a new website or scan a URL in the background to see what is on the page.
3. 'execute_dom_step': Use this to actually perform physical actions on the current webpage (e.g., clicking a button, typing into a text box, or analyzing a screenshot).

RULES:
- Think step-by-step before calling a tool.
- You are an autonomous agent, not a chatbot. You must call a tool to advance the state.
- Once you determine the user's ultimate goal has been achieved across the web pages, use 'task_complete' to halt the pipeline.
- If you receive a critical error or warning from the system, read it carefully and use your best judgment to either retry or halt.
CRITICAL EXECUTION RULE: Do not output any Markdown or text formatting inside the function call arguments. Your final tool call response must be exclusively valid JSON conforming to the schema. Do not write thoughts inside JSON values.`;

const BrainToolSchemas = [
  {
    type: "function",
    function: {
      name: "plan_workflow",
      description: "Generates a multi-step plan for complex intents using the MultiStagePlanner.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string" },
          url: { type: "string" }
        },
        required: ["intent", "url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scout_url",
      description: "Spawns a hidden background tab to analyze a URL using the GhostScoutOrchestrator.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_dom_step",
      description: "Executes a single DOM action using Subphase3Orchestrator.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "e.g., click, type, hover" },
          target: { type: "string", description: "e.g., login button, username field" },
          value: { type: "string", description: "The text to type if action is 'type'" }
        },
        required: ["action", "target"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "task_complete",
      description: "Call this when the task is fully complete.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of actions taken" }
        },
        required: ["summary"]
      }
    }
  }
];

function deepEqual(obj1, obj2) {
  if (obj1 === obj2) return true;
  if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) return false;
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  if (keys1.length !== keys2.length) return false;
  for (let key of keys1) {
    if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) return false;
  }
  return true;
}

export class ReactAgent {
  constructor(tabId, userIntent) {
    this.tabId = tabId;
    this.userIntent = userIntent;
    this.memory = new MemoryManager(SYSTEM_PROMPT);
    this.isRunning = false;
    this.actionHistory = [];
    this.stepCount = 0;
    this.tabMigrationPending = null;
    this.abortController = new AbortController();
    
    // Initialize legacy orchestrators
    this.planner = new MultiStagePlanner();
    this.ghostScout = new GhostScoutOrchestrator();
    this.subphase3 = new Subphase3Orchestrator();
    this.hybridExecutor = new HybridExecutor();
    this.teacherResolver = null;
  }

  waitForTeacherResponse() {
      return new Promise((resolve) => {
          this.teacherResolver = resolve;
      });
  }

  resumeExecution(message) {
      if (this.teacherResolver) {
          this.teacherResolver(message);
          this.teacherResolver = null;
      } else {
          console.warn("[ReactAgent] resumeExecution called but no pending teacherResolver found.");
      }
  }

  async updateTabId(newTabId) {
    if (this.tabId === newTabId) return;
    console.log(`[ReactAgent] Migrating execution from tab ${this.tabId} to ${newTabId}`);
    this.tabMigrationPending = newTabId;
    if (this.abortController) {
        this.abortController.abort();
    }
  }

  async start() {
    this.isRunning = true;
    console.log(`[ReactAgent] Starting task: ${this.userIntent} on tab ${this.tabId}`);
    
    try {
      // Connect HybridExecutor CDP to track network events
      await this.hybridExecutor.connect(this.tabId);
      
      // Initial instruction
      let activeUrl = "unknown URL";
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          const tab = await chrome.tabs.get(this.tabId);
          activeUrl = tab.url || "unknown URL";
        }
      } catch (e) {}
      this.memory.addUserMessage(`Task: ${this.userIntent}\nCurrent URL: ${activeUrl}\nPlease begin execution.`);

      let selfCorrectionAttempts = 0;

      while (this.isRunning) {
        if (this.tabMigrationPending) {
            this.tabId = this.tabMigrationPending;
            this.tabMigrationPending = null;
            this.abortController = new AbortController();
            await this.hybridExecutor.connect(this.tabId);
            console.log(`[ReactAgent] Processing pending migration at loop start to tab ${this.tabId}`);
        }
        
        this.stepCount++;
        if (this.stepCount >= 30) {
          this.isRunning = false;
          throw new Error("Hard limit reached: Exceeded 30 iterations in ReAct loop.");
        }
        try {
          const response = await this._callChatGPT();
          
          // 3. Handle the LLM's response
          if (response.tool_calls && response.tool_calls.length > 0) {
            selfCorrectionAttempts = 0;
            this.memory.addAssistantMessage(response.content || "", response.tool_calls);
            
            for (const toolCall of response.tool_calls) {
              const funcName = toolCall.function.name;
              let args;
              try {
                args = JSON.parse(toolCall.function.arguments);
              } catch (parseError) {
                this.memory.addToolResponse(toolCall.id, funcName, `JSON Syntax Error: ${parseError.message}. Please fix your tool arguments and try again.`);
                continue;
              }
              
              if (funcName === 'task_complete') {
                console.log('[ReactAgent] Task completed by agent.');
                this.isRunning = false;
                break;
              }

              // Loop Management
              const currentAction = { funcName, args };
              this.actionHistory.push(currentAction);
              const recent = this.actionHistory.slice(-4);
              if (recent.length === 4 && recent.every(x => x.funcName === currentAction.funcName && deepEqual(x.args, currentAction.args))) {
                  console.warn("[ReactAgent] Infinite loop detected! Escaping.");
                  this.memory.addToolResponse(toolCall.id, funcName, "SYSTEM ERROR: You have repeated this exact action 4 times. You are in an infinite loop. Try a completely different approach.");
                  continue;
              }

              // Delegate to orchestrators
              let toolResult = "";
              try {
                if (this.tabMigrationPending) {
                    this.tabId = this.tabMigrationPending;
                    this.tabMigrationPending = null;
                    this.abortController = new AbortController();
                    await this.hybridExecutor.connect(this.tabId);
                    this.memory.addToolResponse(toolCall.id, funcName, "Tab migrated, aborting step to re-observe.");
                    break;
                }

                if (funcName === 'plan_workflow') {
                  console.log(`[ReactAgent] Delegating to MultiStagePlanner...`);
                  const plan = await this.planner.planWorkflow(args.intent, args.url);
                  toolResult = JSON.stringify(plan);
                } 
                else if (funcName === 'scout_url') {
                  console.log(`[ReactAgent] Delegating to GhostScoutOrchestrator...`);
                  const ghostTabId = await this.ghostScout.manageTab(args.url);
                  toolResult = `Scout Tab created with ID: ${ghostTabId}. Ready for execution.`;
                } 
                else if (funcName === 'execute_dom_step') {
                  console.log(`[ReactAgent] Delegating to Subphase3Orchestrator...`);
                  const step = { action: args.action, target: args.target };
                  if (args.value !== undefined) step.value = args.value;
                  const result = await this.subphase3.executeStep(this.tabId, step);
                  
                  if (this.tabMigrationPending) {
                      this.tabId = this.tabMigrationPending;
                      this.tabMigrationPending = null;
                      this.abortController = new AbortController();
                      await this.hybridExecutor.connect(this.tabId);
                      this.memory.addToolResponse(toolCall.id, funcName, "Tab migrated during coordinate calculation, aborting step to re-observe.");
                      break;
                  }

                  if (result.status === 'SUCCESS' && result.actionPayload) {
                      if (this.tabMigrationPending) {
                          this.tabId = this.tabMigrationPending;
                          this.tabMigrationPending = null;
                          this.abortController = new AbortController();
                          await this.hybridExecutor.connect(this.tabId);
                          this.memory.addToolResponse(toolCall.id, funcName, "Tab migrated before click execution, aborting step to re-observe.");
                          break;
                      }
                      console.log(`[ReactAgent] Wiring coordinates to HybridExecutor...`);
                      try {
                          const execResult = await this.hybridExecutor.execute(this.tabId, result.actionPayload, result.actionPayload.requires_cdp, this.abortController.signal);
                          
                          if (execResult && execResult.success === false) {
                              if (this.tabMigrationPending) {
                                  this.tabId = this.tabMigrationPending;
                                  this.tabMigrationPending = null;
                                  this.abortController = new AbortController();
                                  await this.hybridExecutor.connect(this.tabId);
                                  this.memory.addToolResponse(toolCall.id, funcName, "Tab migrated before click execution, aborting step to re-observe.");
                                  break;
                              }
                          }
                          
                          console.log(`[ReactAgent] Waiting for network idle...`);
                          await this.hybridExecutor.waitForNetworkIdle();
                          
                          if (this.tabMigrationPending) {
                              this.tabId = this.tabMigrationPending;
                              this.tabMigrationPending = null;
                              this.abortController = new AbortController();
                              await this.hybridExecutor.connect(this.tabId);
                              this.memory.addToolResponse(toolCall.id, funcName, "Tab migrated after action execution, aborting step to re-observe.");
                              break;
                          }
                          
                          toolResult = JSON.stringify({ status: 'SUCCESS', actionExecuted: true });
                      } catch (execErr) {
                          toolResult = JSON.stringify({ status: 'FAILED', reason: execErr.message });
                      }
                  } else if (result.status === 'ESCALATED' || result.status === 'FAILED') {
                      console.log(`[ReactAgent] Action ${result.status}. Freezing ReAct loop for Teacher AI...`);
                      const teacherMessage = await this.waitForTeacherResponse();
                      console.log(`[ReactAgent] Teacher AI responded. Resuming loop...`);
                      toolResult = JSON.stringify({ status: 'TEACHER_CLARIFICATION', message: teacherMessage });
                  } else {
                      toolResult = JSON.stringify(result);
                  }
                }
                else {
                  toolResult = `Unknown tool: ${funcName}`;
                }
              } catch (err) {
                toolResult = `Error executing ${funcName}: ${err.message}`;
              }

              this.memory.addToolResponse(toolCall.id, funcName, toolResult);
            }
          } else {
            // Handle alternative text responses or structural errors
            if (response.content && response.content.includes("[SYSTEM ROUTING ERROR]")) {
                selfCorrectionAttempts++;
                
                if (selfCorrectionAttempts > 3) {
                    console.error('[ReactAgent] DeepSeek exceeded maximum self-correction attempts (3). Halting task to prevent loop execution crash.');
                    this.memory.addSystemMessage("[SYSTEM FATAL]: The model failed to generate syntactically correct JSON tools after 3 attempts. Aborting.");
                    this.isRunning = false;
                    break;
                }

                console.warn(`[ReactAgent] DeepSeek Syntax Error (Attempt ${selfCorrectionAttempts}/3). Feeding back into loop for self-correction.`);
                
                // Feed the error cleanly to the agent as a systemic framework alert
                this.memory.addUserMessage(response.content); 
                continue; // Safely retry the next iteration block
            }

            // Standard operational conversation path: The model legitimately wants to chat with the user
            this.memory.addAssistantMessage(response.content);
            console.warn('[ReactAgent] Model output text without tool call. Halting task.', response.content);
            this.isRunning = false;
            break;
          }
          
          this.memory.pruneHistoryIfNeeded();

        } catch (error) {
          console.error('[ReactAgent] Error in ReAct loop:', error);
          this.isRunning = false;
        }
      }
    } finally {
      // Disconnect HybridExecutor CDP when task finishes
      await this.hybridExecutor.disconnect();
    }
  }

  _preProcessDeepSeekPayload(payload) {
    if (payload.model !== "deepseek/deepseek-r1-distill-llama-70b") {
        return payload; // No-op for standard models
    }

    if (!payload.tools || payload.tools.length === 0) {
        return payload; // No tools to transform
    }

    // 1. Serialize schemas into a clean, readable text block
    const schemasString = JSON.stringify(payload.tools, null, 2);

    // 2. Construct the strict system wrapper constraint
    const systemConstraint = `\n\n=== CRITICAL TOOL CALLING PROTOCOL ===
You have access to specialized external tools. To execute an action, you must select exactly ONE tool from the list below and output a single JSON object matching this exact routing schema:

{
  "tool_name": "The exact name of the tool function you want to call",
  "parameters": {
    // Key-value pairs conforming strictly to the parameters of that specific tool
  }
}

CRITICAL RULES:
1. Do not use Markdown code blocks other than strict \`\`\`json wrappers around your object.
2. Ensure there are no trailing commas or characters outside the JSON structure.
3. You must exclusively pick a tool from the permitted list.

ALLOWED TOOLS SCEMAS:
${schemasString}
======================================
`;

    // 3. Inject constraints into the primary system prompt (index 0)
    if (payload.messages && payload.messages.length > 0 && payload.messages[0].role === "system") {
        payload.messages[0].content += systemConstraint;
    } else {
        // Fallback: If no system prompt exists, prepended it as index 0
        payload.messages.unshift({ role: "system", content: systemConstraint });
    }

    // 4. Strip native OpenAI structural tool hooks to bypass OpenRouter 404 block
    delete payload.tools;
    delete payload.tool_choice;

    // 5. Sanitize message history: Convert structural tool_calls to plain text
    payload.messages = payload.messages.map(msg => {
        if (msg.role === "assistant" && msg.tool_calls) {
            const toolCallText = msg.tool_calls.map(tc => {
                let params = tc.function.arguments;
                try { params = JSON.parse(tc.function.arguments); } catch (e) {}
                return JSON.stringify({ tool_name: tc.function.name, parameters: params });
            }).join("\n");
            return {
                role: "assistant",
                content: msg.content ? `${msg.content}\n${toolCallText}` : toolCallText
            };
        } else if (msg.role === "tool") {
            return {
                role: "user",
                content: `[Tool Execution Result for '${msg.name}']:\n${msg.content}`
            };
        }
        return msg;
    });

    // 6. Enforce optimal temperature for structural consistency
    payload.temperature = 0.6;

    return payload;
  }

  _parseAndSynthesizeResponse(data) {
    let messageContent = data.choices[0].message.content || "";

    // 1. Clear inline reasoning tags if leaked into standard text streams
    if (messageContent.includes("<think>")) {
        messageContent = messageContent.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    }

    let rawJsonString = messageContent;

    // 2. Strategy A: Standard markdown wrapper extraction
    if (rawJsonString.includes("\`\`\`json")) {
        const parts = rawJsonString.split("\`\`\`json");
        if (parts[1]) rawJsonString = parts[1].split("\`\`\`")[0];
    } else if (rawJsonString.includes("\`\`\`")) {
        const parts = rawJsonString.split("\`\`\`");
        if (parts[1]) rawJsonString = parts[1];
    }

    // 3. Strategy B: Boundary Scan Fallback (Find first '{' and last '}')
    const firstBrace = rawJsonString.indexOf("{");
    const lastBrace = rawJsonString.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        rawJsonString = rawJsonString.substring(firstBrace, lastBrace + 1);
    }

    // 4. Secure Evaluation and Synthesizer Construction
    try {
        const parsedWrapper = JSON.parse(rawJsonString.trim());

        // Validate the enforced custom routing fields
        if (!parsedWrapper.tool_name) {
            throw new Error("Missing 'tool_name' field at root of JSON payload object.");
        }

        // Standardize output into native format to prevent downstream breakage
        return {
            tool_calls: [{
                id: `call_ds_${Date.now()}`,
                type: "function",
                function: {
                    name: parsedWrapper.tool_name,
                    arguments: JSON.stringify(parsedWrapper.parameters || parsedWrapper)
                }
            }]
        };

    } catch (parseError) {
        console.warn("[Parser Intercept Warning]: Raw compilation failed. Constructing self-correction loop packet.");
        
        // 5. Construct a mock "text response" containing the execution breakdown.
        // Downstream loop handlers must pass this back as a user-role prompt update.
        return {
            content: `[SYSTEM ROUTING ERROR]: Your last execution layout failed compilation rules. 
Reason for failure: ${parseError.message}
Raw text processed: ${rawJsonString}
Please analyze this syntax error, remove invalid characters or trailing commas, and emit a perfectly valid string payload matching {"tool_name": "...", "parameters": {...}}.`
        };
    }
  }

  async _callChatGPT() {
    // Coordinate with ChatGPT as the Brain
    const apiKey = config.OPENROUTER_API_KEY || config.DEEPINFRA_API_KEY;
    const model = "deepseek/deepseek-r1-distill-llama-70b"; // Route via OpenRouter

    const rawPayload = {
      model: model,
      messages: this.memory.getMessages(),
      tools: BrainToolSchemas,
      tool_choice: "auto",
      temperature: 0.6
    };

    // Clean and transform parameters safely
    const processedPayload = this._preProcessDeepSeekPayload(rawPayload);

    const maxRetries = 3;
    let retries = 0;
    while (true) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(processedPayload)
      });

      if (!response.ok) {
        if (response.status === 429 && retries < maxRetries) {
          const waitTime = Math.pow(2, retries) * 1000;
          console.warn(`[ReactAgent] 429 Too Many Requests. Retrying in ${waitTime}ms...`);
          await new Promise(r => setTimeout(r, waitTime));
          retries++;
          continue;
        }
        const errText = await response.text();
        throw new Error(`LLM API Error: ${response.status} ${response.statusText}. ${errText}`);
      }

      const data = await response.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(`LLM API returned invalid data structure: ${JSON.stringify(data)}`);
      }
      
      // 1. If OpenRouter passed reasoning in the dedicated field, log it for debugging
      if (data.choices[0].message.reasoning) {
          console.log("[ReactAgent DeepSeek Thought]:", data.choices[0].message.reasoning);
      }
      
      // Parse, clean, and map fields back into the extension state engine
      return this._parseAndSynthesizeResponse(data);
    }
  }
}
