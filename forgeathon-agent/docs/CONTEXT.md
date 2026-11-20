# How context is selected

Problem: Flask (~17k lines of Python in src + tests) is larger than most context windows, so *what we leave out* matters.

## Principles
1. **Never concatenate whole files.** Every path into the model goes through a budget (`src/context/budget.ts`).
2. **The agent explores; the extension provides cheap, capped tools.** The agent decides what to read.
3. **Show the user what was chosen and why.**

## Pipeline
| Stage | Mechanism | Budget |
|---|---|---|
| Orientation | `repo_map(path?)`: directory tree + top-level symbols per file, detail auto-reduced to fit | 8 000 chars (Flask full map ~5 900) |
| Locate | `search_workspace` (ripgrep, node fallback), `find_symbol` (regex symbol index) | 40 hits, 5 per file |
| Read | `read_symbol` (just the function/class body) or `read_file` with line range | 200 lines default, 8 000 chars cap |
| Explicit | `@file:` / `@symbol:` mentions resolved by the extension and appended to the turn | 6 000 chars each, 20 000 per turn, truncation reported in the panel |
| Explain | `declare_context` tool: the agent lists chosen files + a one-line reason; panel shows it next to the files it actually read | none |

Any result over budget ends with `... [truncated: N more chars; narrow your request]` so the agent knows to narrow, not retry blindly.

## TrueForge context-engineering features used
- **Deferred tool loading**: `list_files`, `read_symbol`, `run_command` are not preloaded; the agent discovers them via `list_tools` / `call_tool` (visible in the TrueForge session). Hot-path tools are listed in `preload_tools`.
- **Compaction** (`context_management.compaction`, trigger at 60k input tokens) and **large tool-response offloading**.
- **Dynamic subagents**: the instructions allow delegating broad exploration to a subagent that returns a summary only.
  (Whether a model chooses to use it is model-dependent; the panel prints "Subagent started" when it does.)

## Known weakness
The symbol index is regex-based (Python/TS/JS/Go/Java), not a language server: no cross-file resolution of imports.
