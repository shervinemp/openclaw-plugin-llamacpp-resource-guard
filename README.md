# OpenClaw Llama.cpp Resource Guard

Pauses local `llama.cpp` inference, saves KV context slots, and frees VRAM when a heavy tool runs. After the tool finishes, restarts the server, polls for health, and restores the saved context — all automatically.

## How It Works

Hooks orchestrate the full cycle:

| Hook | Role |
|------|------|
| `model_call_started` | Increments active-generation counter |
| `model_call_ended` | Decrements counter |
| `before_model_resolve` | Gates new local calls during an active drain |
| `before_tool_call` | Drains GPU, saves KV slots, kills `llama-server` |
| `after_tool_call` | Restarts `llama-server`, polls health, restores slots |
| `gateway_stop` | Kills `llama-server` on gateway shutdown |

**Cycle:**

0. **On gateway start**, plugin spawns `llama-server` (or reuses an existing healthy one)
1. Agent calls a tool in `heavyTools`
2. Plugin waits for active generations to finish, saves KV slots, kills the server
3. Heavy tool runs with VRAM free'd up
4. Plugin spawns the restart command (detached)
5. Polls `/health` — if `llama-server` is alive, up to **60s**; if dead, bails after **5s**
6. Once healthy, restores saved slots and unpauses local agents
7. **On gateway stop**, plugin kills `llama-server`

## Installation

```bash
openclaw plugins install --dangerously-force-unsafe-install <path-to-plugin-root>
```

For development, use a symlink:

```bash
openclaw plugins install --link --dangerously-force-unsafe-install <path-to-plugin-root>
```

> The `--dangerously-force-unsafe-install` flag is required because the plugin uses `child_process` to manage the `llama-server` lifecycle.

Verify the plugin loaded:

```bash
openclaw plugins list | grep llamacpp
openclaw plugins inspect llamacpp-resource-guard --runtime --json
```

## Configuration

Edit `resource-guard-config.json` in the plugin root:

```json
{
  "llamaUrl": "http://127.0.0.1:9000",
  "localProviderId": "local-ai",
  "heavyTools": ["generate_video", "generate_image"],
  "cwd": {
    "win32": "C:\\llama"
  },
  "commands": {
    "start": {
      "linux": "bash ./start_llama.sh",
      "darwin": "bash ./start_llama.sh",
      "win32": "powershell -NoProfile -Command \"cd C:\\llama; & '.\\run_llamacpp.ps1'\""
    },
    "stop": {
      "linux": "pkill -f llama-server",
      "darwin": "pkill -f llama-server",
      "win32": "taskkill /F /IM llama-server.exe"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `llamaUrl` | Base URL of your `llama-server` (`/slots`, `/health` endpoints) |
| `localProviderId` | Provider ID in `openclaw.json` that routes to the local GPU |
| `heavyTools` | Tool names that trigger the VRAM drain |
| `cwd` | Working directory for the start command (per platform, optional). Use if your script uses relative paths |
| `commands.start` | How to boot the server. Detachment is handled by the plugin — no `start /B` needed |
| `commands.stop` | How to kill the server |

## Testing

Add a tool to `heavyTools` and ask the agent to use it. The plugin logs every state transition.

### Diagnostic Log

A trace is written to `$TMPDIR/vram-plugin-test.log`. Watch it during testing:

```bash
tail -f /tmp/vram-plugin-test.log                    # Linux/macOS
Get-Content "$env:TEMP\vram-plugin-test.log" -Wait    # PowerShell
```

## Caveats

- **`before_model_resolve`** is blocked for non-bundled plugins. To enable:
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
- Config is read once at module load. Changes to `resource-guard-config.json` need `openclaw gateway restart`.
- **KV slot save/restore** is optional. Without `--slot-save-path` on `llama-server`, the save endpoint returns 501 and the plugin skips it. With the flag:
  ```
  --slot-save-path /tmp/llama_slots_backup
  ```
  Note: SWA/hybrid models (Qwen3 MoE, Gemma2) invalidate KV cache on save as of `llama.cpp` b9037 — prompt is always re-processed. Save/restore works best on dense decoder-only models (Llama, Mistral).
