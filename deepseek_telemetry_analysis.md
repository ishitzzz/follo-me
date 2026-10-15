# DeepSeek R1 Telemetry Decoder & Loop Analysis

I have extracted the exact inputs and outputs of the 16 API calls DeepSeek made to OpenRouter. This reveals exactly why the agent got stuck in a loop and why the `ReactAgent` loop detector failed to catch it.

## The 16 API Call Loop Breakdown

1. **API Call 1-3:** DeepSeek uses `plan_workflow` and `scout_url` to get its bearings, but realizes it's stuck on the ChatGPT tab without a navigation tool. It decides to call `execute_dom_step` blindly to try and move forward.
2. **API Calls 4-16 (The Runaway Loop):** DeepSeek starts firing `execute_dom_step` calls. But instead of succeeding, it constantly gets an error back.

### What Input was the LLM Getting?
Every time DeepSeek made a tool call like this:
```json
{
  "tool_name": "execute_dom_step",
  "parameters": {
    "action": "click",
    "target": "Maharashtra"
  }
}
```

The `Subphase3Orchestrator` would ping UI-TARS. UI-TARS would successfully find the target and output: `<thought>None</thought><action>click(start_box='(492,280)')</action>`. 
However, the `Subphase3Orchestrator` regex crashed because it expected `[492,280]` instead of `click()`. 
As a result, the `ReactAgent` fed this **Input** back to DeepSeek:
`Error executing execute_dom_step: Vision API Error - Invalid XML schema`

### How the LLM Responded (The Hallucination)
DeepSeek read this error and assumed the problem was its own formatting or that it was clicking the wrong target. So it tried to self-correct by slightly changing its `target` parameter in the next calls.
For example, it would try:
- `target: "Maharashtra"`
- `target: "Select State Name"`
- `target: "dropdown"`
- `target: "Learner Licence"`

## Why Didn't the Loop Detector Catch It?

The `ReactAgent` has a loop detector built into its execution cycle (around line 161 of `ReactAgent.js`). Here is the logic:
```javascript
const recent = this.actionHistory.slice(-4);
if (recent.length === 4 && recent.every(x => x.funcName === currentAction.funcName && deepEqual(x.args, currentAction.args))) {
    // Break the loop and escalate
}
```

**The Flaw:** The loop detector uses `deepEqual(x.args, currentAction.args)`. It only trips if the LLM passes the **exact same arguments 4 times in a row**. 

Because DeepSeek was highly intelligent, it was actively trying to fix the error by changing the target (`Maharashtra` -> `Select State Name` -> etc.). Because the arguments kept changing, `deepEqual` evaluated to `false`, and the loop detector never fired! The agent just spun around 16 times until it likely hit a hard iteration cap or ran out of context length.

## How to Fix This

To fix the runaway loops, we need to modify the loop detector in `ReactAgent.js`. Instead of only checking for exact argument matches, we should implement:
1. **Consecutive Error Breakers:** If the agent gets the *same error* (e.g. `Vision API Error`) 3 times in a row, break the loop and trigger `waitForTeacherResponse()`.
2. **Action Frequency Limits:** If `execute_dom_step` is called 5 times in a row without the DOM actually changing, break the loop. 

This analysis confirms that fixing the UI-TARS regex and the Teacher AI pause-lock (as planned in `milestones.md`) will completely resolve this issue.
