# OpenClaw Llama.cpp Resource Guard

A local hardware orchestrator for OpenClaw. This plugin acts as a Read/Write mutex lock to seamlessly pause local `llama.cpp` text generation, save active KV context slots to disk, and free VRAM whenever a heavy local tool is invoked.

## 1. Directory Structure (Auto-Discovery)
OpenClaw natively discovers TypeScript plugins placed in its designated workspace directory.

Create a folder for the plugin inside your OpenClaw workspace's `plugins` directory:

**Path:** `<your-workspace>/.openclaw/plugins/llamacpp-resource-guard/`

```text
<your-workspace>/.openclaw/plugins/llamacpp-resource-guard/
├── index.ts                     # Your raw TypeScript plugin code
├── resource-guard-config.json   # The plugin's hardware configuration
└── package.json                 # Required for the async-mutex dependency
```

## 2. Plugin Configuration (`resource-guard-config.json`)
This file tells the plugin how to communicate with your local LLM and which tools require a VRAM lock. Ensure this file is saved in the exact same directory as your `index.ts`.

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

### Configuration Variables:
*   **`llamaUrl`**: The base URL and port of your running `llama-server`.
*   **`localProviderId`**: The exact provider ID your OpenClaw agents use when routing requests to the local GPU.
*   **`heavyTools`**: The exact names of any OpenClaw tools/skills that require dedicated VRAM.
*   **`commands.start` & `commands.stop`**: Modify the shell commands to match how you natively boot and kill your `llama-server` on your operating system.

## 3. OpenClaw System Registration (`openclaw.json`)
Because you placed the plugin in `<workspace>/.openclaw/plugins/`, OpenClaw's auto-discovery will find the files automatically. However, to execute the code, you must manually enable it in your main configuration.

Open your primary `openclaw.json` file (usually located at the root of your workspace or in `~/.openclaw/`) and add the `"enabled": true` flag under the `plugins` object:

```json
{
  "plugins": {
    "llamacpp-resource-guard": {
      "enabled": true
    }
  }
}
```
*(Note: If you choose to store the plugin directory outside of your workspace, you must also add `"path": "/absolute/path/to/your/folder"` inside that same block).*

## 4. Usage & Verification
1.  **Install Dependencies:** Navigate to your newly created plugin folder and install the mutex lock dependency locally.
    ```bash
    cd .openclaw/plugins/llamacpp-resource-guard/
    npm install
    ```
2.  **Verify Loading:** Use the OpenClaw CLI to ensure the framework successfully recognizes the plugin.
    ```bash
    openclaw plugins list
    ```
3.  **Trigger the Lock:** Initiate a chat with an agent using your local model, then ask it to run one of your `heavyTools` (e.g., `generate_image`). Your terminal logs will output the state machine telemetry, showing the VRAM drain, tool execution, and context restoration.
