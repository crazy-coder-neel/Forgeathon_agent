# Forge Agent: an editor-native coding agent on TrueForge

Techfest 2026-27 Forge-a-thon submission. A VS Code extension whose entire agent loop runs on
[TrueForge](https://github.com/truefoundry/trueforge) (local mode). The extension never calls a model provider.

**Everything lives in [`forgeathon-agent/`](forgeathon-agent/)**: start with
[`forgeathon-agent/README.md`](forgeathon-agent/README.md) for setup from a clean clone (including how to start
TrueForge locally and load the agent definition), the architecture, the context strategy and the model configuration.

- **Starting point:** from scratch (no upstream fork). MIT licence, see [LICENSE](LICENSE).
- **Agent definition:** [`forgeathon-agent/agent/forgeathon-agent.json`](forgeathon-agent/agent/forgeathon-agent.json)
- **Example model configuration (no secrets):** [`forgeathon-agent/config.example.json`](forgeathon-agent/config.example.json)
- **Demo script for the three fixed tasks:** [`forgeathon-agent/docs/DEMO_SCRIPT.md`](forgeathon-agent/docs/DEMO_SCRIPT.md)

## Repository layout expected by the setup steps

```
<any folder>/
  forgeathon-agent/   this extension
  flask/              git clone of pallets/flask, checked out at tag 3.1.3 (test workspace, not committed here)
  trueforge/          optional reference clone of truefoundry/trueforge (not committed here)
```


## How to run (Windows PowerShell; macOS/Linux notes below)

### Prerequisites
- Node.js 22.14+ (`node -v`), Git, VS Code 1.90+, Python 3.10+
- A free Gemini API key from https://aistudio.google.com/apikey (primary model)
- An OpenRouter API key from https://openrouter.ai/keys (fallback model)
- Optional: Ollama from https://ollama.com/download (local last-resort model)

### 1. Get the code and the test repository
The Flask clone must sit **next to** the `forgeathon-agent` folder (it is git-ignored).

```powershell
git clone https://github.com/crazy-coder-neel/Forgeathon_agent.git
cd Forgeathon_agent
git clone --branch 3.1.3 https://github.com/pallets/flask.git flask
cd flask
python -m venv .venv
.venv\Scripts\activate
pip install -e . "pytest<9"
pytest tests/test_cli.py -q        # baseline: must pass
```

### 2. Build and test the extension
```powershell
cd ..\forgeathon-agent
npm install
npm run build
$env:FLASK_DIR="..\flask"; npm test    # expect: pass 16, fail 0
```

### 3. Start TrueForge in local mode (separate terminal, keep it open)
TrueForge blocks loopback URLs by default, and the extension's MCP server (and Ollama, if used) live on localhost, so allow them:
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
npx @truefoundry/trueforge@latest
```
Open http://localhost:8790 to confirm it is running.

### 4. (Optional) Start Ollama as a third-tier local model (separate terminal)
Skip this if you only want Gemini + OpenRouter: delete the `local-llm` provider and `agents.local` from `config.local.json`.
```powershell
ollama pull gemma4:e2b-it-qat
$env:OLLAMA_CONTEXT_LENGTH=16384
ollama serve
```
If Ollama is already running in the background ("address already in use"), quit it from the tray icon and run the last two lines again.

### 5. Register models and the agent in TrueForge
Keys are read from environment variables and are never stored in the repo.
```powershell
copy config.example.json config.local.json    # git-ignored; edit to change models
$env:GEMINI_API_KEY="<your key>"
$env:OPENROUTER_API_KEY="<your key>"
npm run setup:trueforge
```
Expected output: `provider ok`, `mcp server ok`, `agent ok: forgeathon-primary` (Gemini), `agent ok: forgeathon-fallback` (OpenRouter), and `agent ok: forgeathon-local` if you kept Ollama.
To enable the Ollama tier at runtime, set the VS Code setting `forge.localAgent` to `forgeathon-local`.
The agent definition used is `agent/forgeathon-agent.json`.

### 6. Launch the extension
1. Open the `forgeathon-agent` folder in VS Code (`code .`), ideally from the terminal where the Flask venv is active so the agent's `run_command` finds `pytest`.
2. Press **F5** and choose **"Run Extension (opens ../flask next to this repo)"**.
3. A new window opens on the Flask repo. Work in that window.

### 7. Verify it works
| Check | Expected result |
|---|---|
| `Ctrl+Shift+P` -> **Forge: Hello** | A greeting streams into the "Forge Agent" output channel |
| `Ctrl+Shift+P` -> **Forge: Open Agent Panel** | The agent panel opens |
| Select `get_debug_flag` in `src/flask/helpers.py`, press `Ctrl+Shift+K`, type an instruction | A diff opens with Accept/Reject above each hunk; nothing is written until you accept |
| After accepting, run `git status` in the Flask repo | Only the accepted file is modified |
| Press **Stop** during a run | Streaming stops immediately, diff tabs close, `git status` stays clean |

### Switching models
Edit `config.local.json` (`providers`, `agents.primary`, `agents.fallback`) and re-run `npm run setup:trueforge`. Any catalog provider or OpenAI-compatible endpoint works. The default fallback is OpenRouter (`base_url` `https://openrouter.ai/api/v1`); change `model_id` to any OpenRouter model that supports tool calling. The extension only knows agent names, never a provider.

### macOS / Linux
Replace `$env:NAME="value"` with `export NAME="value"` (for the allow-list use single quotes: `export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`), activate the venv with `source .venv/bin/activate`, and use `cp` instead of `copy`.

### Troubleshooting
- **Hello fails:** TrueForge must be running (step 3) and `npm run setup:trueforge` must have succeeded (step 5).
- **Agent has no tools / MCP error:** TrueForge was started without `OUTBOUND_URL_ALLOWED_HOSTS`. Restart it as in step 3.
- **Port 8791 in use:** close other VS Code windows running the extension.
- **Gemini 429 (free-tier rate limit):** the extension waits and continues the same run automatically.
