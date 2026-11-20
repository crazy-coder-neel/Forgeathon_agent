# TrueForge facts verified from source

Verified by reading `github.com/truefoundry/trueforge` (docs/ and packages/) and by running it
(`npx @truefoundry/trueforge@latest`, server on `http://localhost:8790`, no login in local mode).

| Fact | Where verified |
|---|---|
| Local mode: `npx @truefoundry/trueforge@latest` -> `http://localhost:8790`, SQLite, no auth. Needs Node >= 22.14. | README.md, docs/api/quickstart.mdx |
| SDK `@truefoundry/trueforge-sdk`: `client.sessions.create({agent:{name}})`, `createTurnStream(sessionId,{input:[{type:'user.message',content}]})`, `subscribeToTurn`, `createTurnEvents`, `cancel(sessionId)`. | docs/api/use-agent.mdx, packages/trueforge-sdk/reference.md |
| Stream events: `turn.created`, `model.message` (+ `model.message.delta` fragments merged with `mergeEventDelta`), `tool.response`, `tool.approval_required`, `turn.update` (paused/running), `turn.done`. Tool calls only exist after deltas are merged. | docs/api/overview.mdx, use-agent.mdx; observed live |
| Tool approval: `require_approval_for_tools` on an MCP server pauses the turn; client answers with `user.tool_approval` {allow \| deny+reason} via `createTurnEvents` after `subscribeToTurn`. | docs/api/use-agent.mdx "Tool approvals" |
| Cancel: `sessions.cancel(id)` aborts the model request and closes the stream with a terminal `turn.done` (cancelled). Observed ~20-40 ms in tests. | use-agent.mdx "Cancel a turn" |
| MCP servers are REMOTE URLs registered in settings (`PUT /api/v1/settings/mcp-servers`, `{manifest:{type:'remote',name,url,description}}`); agents attach by name. | docs/mcp-servers.mdx, docs/openapi.json |
| **TrueForge blocks private/loopback outbound URLs (SSRF guard)**, including MCP and model URLs. Start TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'` (or `NETWORK_POLICY_ENABLED=false`). | packages/trueforge-core/src/core/util/ssrfGuard.ts, packages/trueforge/src/config.ts |
| Models: custom OpenAI-compatible provider = `PUT /api/v1/settings/model-providers` `{manifest:{type:'custom',name,base_url,auth:{api_key},models:[{name,model_id,properties}]}}`; agent model FQN = `<provider name>/<model name>`. | docs/models.mdx, openapi.json, observed via GET /api/v1/models |
| **There is NO model fallback in the agent spec** ("automatic model selection ... Planned"). Fallback is therefore implemented in the extension as a second saved TrueForge agent (other model). Still 100% TrueForge; the extension never calls a provider. | docs/models.mdx (Planned note), grep of docs + openapi.json |
| Deferred tool loading (default): tools arrive as `call_tool` {mcp_server, tool_name, input}; `preload_tools` loads chosen tools eagerly. | packages/trueforge-core/src/core/runtime/DeferredTool.ts, docs/create-agent/overview.mdx |
| Agent spec: `model`, `instructions`, `mcp_servers[{name,enable_tools,require_approval_for_tools,preload_tools}]`, `config{dynamic_sub_agents,context_management{compaction,large_tool_response},iteration_limit,...}`. | docs/create-agent/overview.mdx |

## Testing
- `npm test`: 16 tests (hunk logic, rate-limit parsing, MCP tools against real pallets/flask 3.1.3, @mention budgets).
- `npm run test:e2e`: 8 tests against a REAL local TrueForge server with scripted mock models: automatic fallback
  (primary 401 -> second agent), primary endpoint that HANGS (first-token watchdog -> fallback), provider rate limit
  (429 waited out, same TrueForge session continues), approval-driven apply with disk unchanged while pending,
  deferred `call_tool`, new-file proposal, cancellation (<100 ms), both-models-down error, TrueForge-down error.
- `npm run build` + loading the bundle with a stubbed `vscode` module: OK.
- The VS Code UI layer (webview, diff tab, CodeLens clicks, WorkspaceEdit apply, undo) and real-model quality on the
  fixed tasks are verified manually; see docs/DEMO_SCRIPT.md.
