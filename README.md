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
