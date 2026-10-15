# FolloMe Workspace Rules

- Never modify source code or master markdown files without the user explicitly saying "APPROVED". Answering open questions does not constitute approval. Always wait for explicit confirmation before executing implementation plans.
- Do NOT run any automated test scripts (like `node tests/runner.js`). The user will manually run all workflows in the browser. When the user says they have tested the workflow and asks you to check the logs, ONLY then should you read the local telemetry server logs to diagnose issues.
