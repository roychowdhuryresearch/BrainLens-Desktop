# iEEG UI MCP connector (zero-dependency)

Turns the iEEG desktop UI into an **MCP connector** so an external agent (e.g. Claude Code) can
**drive the UI** — read what the clinician sees, move the waveform, select channels/events, stage
detection/classification, and visually inspect the waveform.

Stdlib only. **Do NOT install into the agent's Python env** (`mcp`/`pydantic` pins conflict with the
agent's `fastapi 0.109`). It runs with a plain `python`.

## Pieces

- **`broker.py`** — the UI bus (stable hub, hosted by the desktop app). Bridges two sides:
  - Renderer/Electron: `POST /ui/state` · `GET /ui/commands` (drains) · `POST /ui/ack`
  - MCP / agent: `POST /ui/emit` (catalog-validated, enqueues) · `GET /ui/state`
- **`mcp_server.py`** — stdio MCP server (transient, spawned by the MCP client). Thin broker client.
  Tools: `search_tools`, `list_tool_categories`, `get_ui_state`, `emit_ui_command`,
  `wait_for_ui_command`, `inspect_waveform`.
- **`selftest.py`** — zero-dep end-to-end proof of the round-trip (no model). `python ui_mcp/selftest.py`.

## Data flow

```
Claude (MCP stdio) ──emit_ui_command──▶ broker queue ──GET /ui/commands──▶ renderer stages/applies
Claude (MCP stdio) ◀──get_ui_state──── broker state ◀──POST /ui/state──── renderer reports what's shown
Claude (MCP stdio) ◀─wait_for_ui_command─ broker ack ◀──POST /ui/ack──── renderer/backend reports staged/complete/failed
```

Commands validate against the authoritative `contracts/ui-command-catalog.json`. Write-class commands
(`compute|artifact_write|review_write|destructive`) carry `requires_confirmation` → the renderer
**stages** them for explicit human Apply under review autonomy, or starts them immediately only when
desktop autonomy explicitly allows it. `emit_ui_command` confirms delivery only. For commands whose
response has `requires_completion_callback=true`, the agent must call `wait_for_ui_command` before
claiming the command is waiting, complete, or failed.

`detection.run` has an additional MCP-side payload policy gate before the command is enqueued:
detector/protocol, compatible biomarker, parameter preset or confirmed defaults, filter band, and
channel scope must be explicit in the structured payload. Underspecified detector runs return a
clarification response and never reach the broker queue.

## Run

```bash
# 1) start the broker (the desktop app should host this; for dev, run it standalone)
python -m ui_mcp.broker --host 127.0.0.1 --port 8770     # from the repo root

# 2) add the MCP server to your Claude Code .mcp.json
#    (the broker URL is how the connector finds the running UI)
```

```json
{
  "mcpServers": {
    "ieeg-ui": {
      "command": "python",
      "args": ["/ABS/PATH/ui_mcp/mcp_server.py"],
      "env": {
        "IEEG_UI_BROKER_URL": "http://127.0.0.1:8770",
        "IEEG_UI_VLM_API_KEY": "<optional, for inspect_waveform>",
        "IEEG_UI_VLM_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "IEEG_UI_VLM_MODEL": "qwen3-vl-flash"
      }
    }
  }
}
```

Restart Claude Code → the `ieeg-ui` tools appear → Claude can drive the UI.

## Live app contract

The Electron renderer posts live UI state to `/ui/state`, polls `/ui/commands`, applies validated
commands through the workspace command dispatcher, and posts `/ui/ack` for staged/applied/final
outcomes. `wait_for_ui_command` is the callback path the agent should use after compute, analysis,
artifact, destructive, and review-write commands.
