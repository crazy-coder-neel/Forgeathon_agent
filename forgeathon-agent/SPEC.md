# SPEC (read this before changing anything)
Forge-a-thon eligibility: the agent loop runs on TrueForge; the extension never calls a model provider; editor
capabilities are MCP tools; models are configured in TrueForge; agent definition lives in `agent/`; no secrets committed.
Five capabilities: inline edit, agent mode (3+ files unprompted), context assembly with budget, per-hunk diff review with undo
(no silent writes), streaming + instant cancellation. Fixed tasks A/B/C on pallets/flask 3.1.3: see docs/DEMO_SCRIPT.md.
Facts about TrueForge's API that were verified: NOTES.md. Do not invent API shapes: read `../trueforge` or ask.
