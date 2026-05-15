# OpenClaw Llama.cpp Resource Guard

A plugin that pauses local `llama.cpp` inference, saves active KV context slots to disk, and frees VRAM whenever a heavy GPU tool is invoked. After the tool finishes, it restarts the server, polls health, and restores the saved context.

## Plugin Architecture

```
llamacpp-resource-guard/
├── openclaw.plugin.json         # Plugin manifest
├── package.json                 # ESM module config + openclaw extensions
├── index.ts                     # Source TypeScript
├── tsconfig.json                # TypeScript compiler config
├── resource-guard-config.json   # Hardware paths and tool list
└── dist/index.js                # Compiled JS (what actually runs)
```

## How It Works

The plugin registers 5 hooks via `api.on()`:

| Hook | Purpose |
|------|---------|
| `model_call_started` | Tracks active local model calls (increments counter) |
| `model_call_ended` | Decrements counter when call finishes |
| `before_model_resolve` | Gate: blocks new local model calls during a drain |
| `before_tool_call` | Drains GPU, saves KV slots, kills `llama-server` |
| `after_tool_call` | Restarts `llama-server`, polls health, restores slots |

### Cycle

1. Agent uses a tool listed in `heavyTools`
2. `before_tool_call` fires → waits for active model calls to finish → saves slots → kills llama
3. Heavy tool runs with freed VRAM
4. `after_tool_call` fires → spawns restart command (detached) → polls `/health` every 1s
5. If `llama-server.exe` process is alive: polls up to **300s** (model may be loading)
6. If process is dead: bails after **3 retries** (no point waiting)
7. Once healthy: restores saved slots → sets state back to `IDLE`

## Installation

```bash
# From the plugin root directory
openclaw plugins install <path-to-plugin-root>
```

Or with a symlink for development:
```bash
openclaw plugins install --link <path-to-plugin-root>
```

Verify:
```bash
openclaw plugins list | grep llamacpp
openclaw plugins inspect llamacpp-resource-guard --runtime --json
```

## Configuration (`resource-guard-config.json`)

```json
{
  "llamaUrl": "http://127.0.0.1:9000",
  "localProviderId": "local-ai",
  "heavyTools": ["generate_video", "generate_image"],
  "commands": {
    "start": {
      "linux": "./start_llama.sh",
      "darwin": "./start_llama.sh",
      "win32": "cmd /c start /B powershell -File start_llama.ps1"
    },
    "stop": {
      "linux": "pkill -f llama-server",
      "darwin": "pkill -f llama-server",
      "win32": "taskkill /F /IM llama-server.exe"
    }
  }
  }
}
```

### Fields

- **`llamaUrl`** — Base URL of your running `llama-server` (used for `/slots`, `/health` endpoints)
- **`localProviderId`** — Your provider ID in `openclaw.json` (e.g. `"local-ai"`)
- **`heavyTools`** — Tool names that trigger the VRAM drain cycle
- **`commands.start`** — How to boot the server. **Windows must use `start /B`** to detach the process so it survives the hook cycle
- **`commands.stop`** — How to kill the server

## Testing

Add a tool to your `heavyTools` list and send an agent message telling it to use that tool. The plugin's state machine will log every transition.

### Diagnostic Log

The plugin writes a trace to `$TMPDIR/vram-plugin-test.log` showing every hook firing and state transition. Tail it during testing:

```bash
tail -f /tmp/vram-plugin-test.log     # Linux/macOS
Get-Content -Path "$env:TEMP\vram-plugin-test.log" -Wait  # PowerShell
```

## Caveats

- **`before_model_resolve`** is blocked for non-bundled plugins by default. To enable it, add to `openclaw.json`:
  ```json
  {
    "plugins": {
      "entries": {
        "llamacpp-resource-guard": {
          "hooks": { "allowConversationAccess": true }
        }
      }
    }
  }
  ```
- The plugin reads the config file once at module load. Changes to `resource-guard-config.json` require a gateway restart: `openclaw gateway restart`
- Plugin-registered tools (like `mock_heavy_tool`) need `contracts.tools` in `openclaw.plugin.json` and `tools.allow` in config to surface to the agent
- **Slot save/restore** requires `llama-server` to be started with `--slot-save-path <dir>`. Without it, `POST /slots/{id}?action=save` returns 501. Add it to your server arguments:
  ```
  --slot-save-path /tmp/llama_slots_backup
  ```
  The plugin saves slots to a temp directory and restores them after the LLM reboots. Without this flag, the plugin will still kill and restart the server correctly — it just won't be able to preserve the KV cache across the restart.
