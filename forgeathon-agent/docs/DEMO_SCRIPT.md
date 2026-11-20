# Demo script (max 4 minutes) and pre-flight checklist

## Pre-flight (do this BEFORE recording; the VS Code UI layer has not been run by the author of this code)
- [ ] `npm install && npm run build && npm test` pass; TrueForge started with `OUTBOUND_URL_ALLOWED_HOSTS` (see README)
- [ ] `npm run setup:trueforge` ok; F5 opens a window on the Flask clone at tag 3.1.3 (`git log -1` starts with 22d92470)
- [ ] *Forge: Hello* streams a greeting
- [ ] Diff opens, lenses appear, reject one hunk -> it disappears from the diff, accept -> file is saved, *Undo* restores it
- [ ] Stop mid-run closes diff tabs; `bash scripts/verify-clean.sh` in Flask prints CLEAN
- [ ] Task A, B rehearsed 3x with your real model; tune `agent/forgeathon-agent.json` instructions (not code) if Task B touches < 3 files
- [ ] Flask venv active in the terminal you launch VS Code from (so `run_command` finds `python -m pytest`)

## Recording (editor visible the whole time; do not cut between instruction and diff)
**Task A (0:00-1:15)** Open `src/flask/helpers.py`, select `get_debug_flag`, `Ctrl+Shift+K`, type exactly:
`Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
Show the diff + lenses, accept hunks (reject one to show per-hunk control, then re-run if needed). Terminal:
`FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` -> `False`. Show *Undo* once.

**Task B (1:15-2:50)** Open the panel, no files mentioned, type exactly:
`Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
Point at "Files chosen & why" and the tool log (repo_map -> search -> read). Review each file's hunks and accept (>= 3 files: `src/flask/cli.py`, `tests/test_cli.py`, docs). Briefly show the TrueForge session (`http://localhost:8790`: turns, tool calls, `list_tools`/`call_tool`). Terminal: `pytest tests/test_cli.py -q` passes; run `flask --app <any app> config` and show masked JSON; `git diff --stat` shows >= 3 files.

**Task C (2:50-3:45)** Break the primary (wrong key or unreachable `base_url`; re-run `npm run setup:trueforge`). Repeat Task A: the panel shows the retry/fallback notes and the fallback model proposes the diff (or both broken -> clear error). Editor stays responsive; run `bash scripts/verify-clean.sh` -> CLEAN. Optional: press Stop mid-run to show instant cancellation.

## After recording
Fill timestamps in `docs/WRITEUP.md` section 6, export it to PDF (1-3 pages), make repo + video public, open both links in an incognito window. Deadline 20 Nov 2026, 23:59 IST.

## Notes for the Gemini + Ollama configuration
- Start Ollama with `OLLAMA_CONTEXT_LENGTH=16384` (PowerShell: `$env:OLLAMA_CONTEXT_LENGTH=16384; ollama serve`) and make sure the fallback model is pulled (`ollama pull gemma4:e2b-it-qat`).
- Task C recipe: set an invalid key (`$env:GEMINI_API_KEY="invalid"`), run `npm run setup:trueforge`, repeat Task A: the panel prints the retry and "Switching automatically to fallback agent" notes and the local model proposes the diff. Restore the real key and re-run setup afterwards.
- Time budget for 4:00: Task A 1:00, Task B 1:45, Task C 1:00, spare 0:15. You may cut model waiting time, but never cut between the instruction and the diff appearing.
- Free-tier Gemini rate limits are waited out automatically (the panel says so); trim that wait in the edit, not the instruction-to-diff moment.
