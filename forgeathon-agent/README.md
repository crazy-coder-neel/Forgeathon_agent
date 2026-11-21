# Forge Agent: an editor-native coding agent on TrueForge

VS Code extension whose **entire agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge)**
(Techfest 2026-27 Forge-a-thon). The extension is only a *client*: it creates TrueForge sessions, sends turns,
renders streamed events, and exposes editor capabilities to the agent as **MCP tools**. It never calls a model provider.

**Starting point: from scratch** (no upstream fork; MIT licence). Dependencies: `@truefoundry/trueforge-sdk`,
`@modelcontextprotocol/sdk`, `diff`, `zod`.

```
VS Code extension (client)                          TrueForge (local: npx @truefoundry/trueforge)
 ├─ Agent panel (webview): stream, tool log,  ───►   sessions / turns / streaming events / tool approval
 │   "files chosen & why", Stop                      agent "forgeathon-primary"  ──► model A
 ├─ Review manager: native diff + per-hunk lenses    agent "forgeathon-fallback" ──► model B
 └─ Editor MCP server (127.0.0.1:8791/mcp)  ◄─────   agent calls: repo_map, search_workspace, find_symbol,
     repo_map list_files search_workspace            read_file, read_symbol, declare_context,
     find_symbol read_file read_symbol               propose_edit / propose_write (approval = diff review),
     declare_context propose_edit propose_write      run_command (approval)
     run_command
```

## Requirements
- **Node.js >= 22.14** (TrueForge requirement), npm, Git, VS Code >= 1.90
- Python 3.10+ for the Flask tasks (`pip install -e . pytest` inside a venv in the Flask clone)
- One model (free tier, paid API, or local OpenAI-compatible endpoint such as Ollama) plus a second one for fallback

## Setup from a clean clone
```bash
# 0. clone this repo, then the competition's pinned test workspace NEXT TO the extension folder
git clone https://github.com/champ-byte/Forgeathon_agent.git && cd Forgeathon_agent
git clone --branch 3.1.3 https://github.com/pallets/flask.git flask
#    inside flask/:  python -m venv .venv && .venv\Scripts\activate (Windows) | source .venv/bin/activate
#                    pip install -e . "pytest<9"       (pytest 9 breaks Flask 3.1.3's own test suite)
#    The extension's run_command tool automatically uses flask/.venv when it exists.

# 1. this extension
cd forgeathon-agent
npm install
npm run build
npm test                     # 16 tests, no TrueForge needed (set FLASK_DIR=../flask)

# 2. start TrueForge locally in its own terminal.  IMPORTANT: allow loopback (see note below)
#    macOS/Linux:   OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
#    PowerShell:    $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx @truefoundry/trueforge@latest
#    cmd.exe:       set OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"] && npx @truefoundry/trueforge@latest

# 3. configure models (keys come from env vars, never from files)
cp config.example.json config.local.json        # edit providers + agents.primary / agents.fallback
export GEMINI_API_KEY=...                        # PowerShell: $env:GEMINI_API_KEY="..."   (primary)
export OPENROUTER_API_KEY=...                    # PowerShell: $env:OPENROUTER_API_KEY="..."   (fallback; Ollama as optional 3rd tier needs no key)
npm run setup:trueforge                          # registers providers, the MCP server and the agents via TrueForge's API

# 4. run the extension
code .                       # open THIS folder and press F5: a new window opens on ../flask with the extension loaded
#                              (use the second launch entry, "choose the Flask folder", to open a different workspace)
```
In the new window: `Ctrl+Shift+P` -> **Forge: Hello (TrueForge smoke test)** should stream a greeting into the
*Forge Agent* output channel. Then **Forge: Open Agent Panel**.

> **Why the allow-list?** TrueForge's SSRF guard blocks loopback/private URLs for MCP servers and models by default
> (`packages/trueforge-core/src/core/util/ssrfGuard.ts`). The extension's MCP server listens on `127.0.0.1`, and
> local models (Ollama) do too, so TrueForge must be started with `OUTBOUND_URL_ALLOWED_HOSTS` as shown.

## Using it
| Capability | How |
|---|---|
| **Inline edit** | Select code, `Ctrl+Shift+K` (`Cmd+Shift+K` on macOS), type the instruction. A diff opens; use the **Accept / Reject** CodeLens above each hunk. |
| **Agent mode** | *Forge: Open Agent Panel*, type a request, Enter. The agent explores, then each file change opens as a diff for review. |
| **@mentions** | In the panel type `@` for autocomplete: `@file:src/flask/cli.py`, `@symbol:get_debug_flag`. Attached text is size-capped; the panel shows what was attached. |
| **Diff review** | Native diff editor + per-hunk lenses (Accept / Reject / Accept all / Reject all). Rejected hunks disappear from the diff. Nothing is written until you decide. |
| **Undo** | *Forge: Undo Last Applied Change* (or the panel button). Also normal `Ctrl+Z` in the editor. |
| **Stop** | Panel **Stop** button, status-bar item, or `Ctrl+Shift+Esc`. Cancels the TrueForge turn, closes open reviews and kills running commands. |

## Switching models
Edit `config.local.json` (`providers`, `agents.primary`, `agents.fallback`) and re-run `npm run setup:trueforge`
(idempotent), or change models in TrueForge's own UI (Settings -> Models, then edit the agent). The extension
only knows agent *names* (`forge.primaryAgent`, `forge.fallbackAgent` settings), never a provider.

## Resilience (Task C)
1. `forgeathon-primary` fails (bad key, unreachable endpoint): retry with exponential backoff (`forge.maxRetries`, default 2: 1 s, 2 s).
2. Still failing: **automatic switch to `forgeathon-fallback`** (OpenRouter by default, a second TrueForge agent on another model). The panel says so.
3. Optional: if `forge.localAgent` is set (for example `forgeathon-local` on Ollama), it is tried after the fallback fails.
4. All fail: a clear error message. Nothing is ever written before an accept, so `git status` stays clean.
A restart is only attempted if the agent has not yet made any tool call (so side effects are never repeated).
*Honest note:* TrueForge itself has no model-fallback feature yet (documented as "planned"), so the fallback is orchestrated by the extension using two TrueForge agents.

## Context strategy (details in docs/CONTEXT.md)
repo_map (size-capped tree + top-level symbols) -> search_workspace / find_symbol -> read_symbol / read_file line ranges.
Every tool result is capped (8 000 chars), `read_file` defaults to 200 lines, `@mentions` are capped at 6 000 chars each
and 20 000 per turn. TrueForge context features used: **deferred tool loading** (`list_files`, `read_symbol`,
`run_command` load on demand via `call_tool`), **compaction** and **large tool-response offloading** (enabled in the
agent spec) and **dynamic subagents** (the agent is told it may delegate broad exploration).

## Layout
```
agent/forgeathon-agent.json   TrueForge agent definition (template for primary + fallback)
config.example.json           model configuration example (no secrets)
scripts/setup-trueforge.mjs   registers providers + MCP server + agents through TrueForge's HTTP API
src/trueforge/client.ts       sessions, turns, streaming, approvals, cancel, retry + fallback
src/mcp/                      editor MCP server + tools (pure Node, unit-tested)
src/review/                   hunks.ts (pure), plan.ts (pure), manager.ts (diff UI, apply, undo)
src/context/                  budget, repo map, search, symbols, @mentions
src/controller.ts, src/ui/    orchestration + webview panel
test/                         unit tests, MCP tests on real Flask, e2e tests on real TrueForge (mock models)
docs/                         WRITEUP.md (8 headings), DEMO_SCRIPT.md, CONTEXT.md
```

## Status / known limitations
See `NOTES.md` (what was and was not tested) and `docs/WRITEUP.md` section 8.
