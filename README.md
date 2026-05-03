# OpenClaw Llama.cpp Resource Guard Plugin

`openclaw-plugin-llamacpp-resource-guard` is a native OpenClaw plugin designed to manage local GPU concurrency and prevent VRAM exhaustion. It acts as a Read/Write lock orchestrating the handoff between a local `llama.cpp` server (handling agent text generation) and heavy local tools (like image or video generation) using OpenClaw's standard lifecycle hooks.

## Core Mechanics

*   **Provider Filtering:** Exclusively regulates agents routed to the local LLM. Agents utilizing cloud APIs bypass the lock entirely and run unimpeded.
*   **Zero-Starvation Draining:** When a heavy tool is queued, new local LLM requests are paused, but active streams finish gracefully to prevent crashes or lost text.
*   **KV Cache Persistence:** Before terminating the LLM, it queries the `llama.cpp` `/slots` API and writes active context windows to a cross-platform temporary disk directory.
*   **Seamless Restoration:** After the heavy tool completes, it reboots the LLM, restores the saved KV cache, and unpauses waiting agents so they resume immediately.

## Setup Requirements

This plugin requires the `async-mutex` library to prevent the Tool Race Condition:

```bash
npm install async-mutex
```

## Configuration

Place `vram-config.json` in the root of your OpenClaw workspace (next to `package.json`). This keeps your hardware configuration decoupled from the source code.

Example `vram-config.json`:

```json
{
  "llamaUrl": "http://127.0.0.1:8080",
  "localProviderId": "openai-compatible-local",
  "heavyTools": ["generate_video", "generate_image", "train_lora", "mock_heavy_tool"],
  "commands": {
    "start": {
      "linux": "bash /opt/llama/start_llama.sh",
      "darwin": "sh /Users/Shared/llama/start_llama.sh",
      "win32": "start.bat"
    },
    "stop": {
      "linux": "pkill -f llama-server",
      "darwin": "pkill -f llama-server",
      "win32": "taskkill /F /IM llama-server.exe"
    }
  }
}
```

The plugin automatically selects the correct start/stop commands based on the operating system (`win32`, `darwin`, `linux`).

## Deployment

1. Drop the JSON config into your root.
2. Ensure the plugin implementation (`src/plugins/llamacpp-resource-guard.ts`) is present.
3. Inject `vramOrchestratorHooks` into your plugin registry.
