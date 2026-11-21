# Forge Agent: an editor-native coding agent on TrueForge

## 1. Team
Neelay Joshi · Niranjan Patil · Kavya Zala · Athrva Sarade · Techfest Team ID: TM-5DE13334B85
Repository: https://github.com/champ-byte/Forgeathon_agent

## 2. Starting point
**From scratch.** No upstream fork, so there is no fork commit to declare. MIT licence. Third-party code is limited to ordinary dependencies (`@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff`, `zod`, `esbuild`). The full history is in git. AI coding assistants (Claude by Anthropic and Google Gemini) were used for scaffolding, review-system code, test generation, and security hardening.

## 3. Architecture on TrueForge
The extension is a pure client of TrueForge running locally (`npx @truefoundry/trueforge@latest`). Through the TypeScript SDK it creates a session on a saved agent, sends a turn, and renders the streamed events (`model.message` deltas, tool calls, `tool.response`, subagent and compaction events). It never calls a model provider.
- **Editor capabilities are MCP tools.** The extension hosts a Streamable-HTTP MCP server on `127.0.0.1:8791`, registered in TrueForge as remote server `forge-editor`: `repo_map`, `list_files`, `search_workspace`, `find_symbol`, `read_file`, `read_symbol`, `declare_context`, `propose_edit`, `propose_write`, `run_command`. The agent decides what to read and change.
- **TrueForge tool approval drives diff review.** `propose_edit`, `propose_write` and `run_command` are in `require_approval_for_tools`. When TrueForge pauses the turn, the extension builds the hunks, opens the native diff with per-hunk Accept/Reject lenses, applies only accepted hunks through `WorkspaceEdit`, then answers `user.tool_approval`. The MCP tool never writes; it reports what the user applied ("Applied 2 of 3 hunks"), so the agent adapts. Rejecting everything is a `deny` with a reason.
- **Harness features used:** tool approval, deferred tool loading (`list_files`, `read_symbol`, `run_command` load on demand via `call_tool`; hot-path tools are in `preload_tools`), compaction, large tool-response offloading, dynamic subagents, session cancel and streaming. They keep the window small, make review safe, and make Stop instant.
- **Design choice:** `propose_edit` takes search/replace pairs instead of whole-file content, so the model cannot silently rewrite code it was not asked to touch.
- **Security:** Sensitive environment variables are stripped from child processes, redacted from tool outputs, and protected files (.env, config.local.json, private keys) are blocked from agent read/write access.
- **Agent definition:** `forgeathon-agent/agent/forgeathon-agent.json`, saved twice (primary and fallback agent) by `npm run setup:trueforge`.

## 4. How context is selected
Agent-driven retrieval with hard budgets (`src/context/budget.ts`): `repo_map` (tree plus top-level symbols, auto-shrunk to 8 000 chars; the whole Flask map is about 5 900) → `search_workspace` / `find_symbol` → `read_symbol` or `read_file` line ranges (200 lines by default). Every tool result is capped at 8 000 chars and says when it was truncated. Explicit `@file:` and `@symbol:` mentions are resolved by the extension and attached within 6 000 chars each and 20 000 per turn; the panel shows what was attached. Before editing, the agent calls `declare_context`: the panel's **Files chosen & why** lists each file with its reason next to the ranges it actually read.

## 5. Model setup
| Role | Model | Where it runs | Approx. cost |
|---|---|---|---|
| Primary | Google Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`), TrueForge `google-gemini` catalog provider | Google API, free tier | ₹0 |
| Fallback | OpenRouter free-model router (`openrouter/free`) via OpenRouter, TrueForge `custom` OpenAI-compatible provider | OpenRouter API (free model) | ₹0 |
| Optional 3rd tier | Gemma 4 e2b (`gemma4:e2b-it-qat`) via Ollama, enabled with `forge.localAgent` | Local laptop | ₹0 |

Models are configured in TrueForge only. To switch, edit `config.local.json` (providers, `agents.primary`, `agents.fallback`) and run `npm run setup:trueforge`, or edit the agent in TrueForge's UI. The extension only knows agent names. Keys live in environment variables; `config.example.json` ships without secrets.

**Resilience:** Retry with exponential backoff (default 2 retries: 1s, 2s) → rate-limit wait-out (HTTP 429, up to 90s, same session continues) → first-token watchdog (30s, catches hanging endpoints) → automatic fallback to second agent. Restart on another model only before any side-effecting tool call. Nothing is ever written before an accept, so `git status` stays clean.

## 6. Scorecard
| Criterion | Claim |
|---|---|
| A1 Inline edit | Selection + `Ctrl+Shift+K` + instruction opens a native diff with per-hunk Accept/Reject |
| A2 Agent mode | Task B: the agent finds and edits 3+ files, none named |
| A3 Streaming, cancellation | Tokens stream from TrueForge events; Stop cancels in < 100 ms, closes reviews, nothing half-applied |
| B1 Context assembly | Budgeted retrieval; Files chosen & why visible in Task B |
| B2 Diff safety | Per-hunk review, nothing on disk before accept, undo shown |
| B3 Resilience | Retry with backoff, then automatic switch to the second model; `git status` clean |
| B4 TrueForge depth | MCP tools, approval drives review, deferred loading and compaction visible in the session |
| C1 Video | Tasks A, B, C in order, each verified on screen |
| C2 Write-up | This document |

## 7. Tools used
AI coding assistants: Claude (Anthropic) and Google Gemini for scaffolding, the review and TrueForge client code, tests, and security hardening. Also VS Code, Node.js, TypeScript, esbuild, TrueForge (local mode), Ollama, Flask 3.1.3 as the test repository. Security tooling: custom secret scanner (`scripts/scan-secrets.mjs`), runtime secret protection (`isProtectedPath`, `isSensitiveEnvVar`, `redactSecrets`, `commandEnv` sanitisation), dedicated security test suite (`test/security.test.ts`).

## 8. Known limitations and what we would do with another month
- Symbols come from a regex index, not a language server, so there is no import resolution. A tree-sitter or LSP-backed index would improve retrieval.
- TrueForge has no native model fallback yet, so fallback is orchestrated by the extension: retry with backoff, a first-token timeout for endpoints that hang, waiting out provider rate limits on the same session, then a second saved TrueForge agent. We would contribute native fallback to TrueForge.
- Restarting on another model is only attempted before any side-effecting tool call; later failures surface as a clear error.
- Task quality depends on the model. A 2B local fallback is slower and weaker than the primary; the behaviours (diff, review, cancel) do not depend on it.
- Approvals are per call and commands run on the host (each one approved by the user); no sandbox.
- Automated tests (14 unit + security tests, 8 end-to-end against a local TrueForge with scripted mock models) cover logic and the TrueForge flow; the VS Code UI layer is verified manually.
