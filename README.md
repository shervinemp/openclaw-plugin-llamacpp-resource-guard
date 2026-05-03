# OpenClaw Llama.cpp Resource Guard

A local hardware orchestrator for OpenClaw. This plugin acts as a Read/Write mutex lock, seamlessly pausing local `llama.cpp` text generation, saving active KV context slots to disk, and freeing VRAM whenever a heavy local tool (like image or video generation) is invoked.

## 1. Directory Structure
Create a dedicated folder for this plugin anywhere on your machine. Place your compiled plugin code (`index.js`), your `package.json` (if you are managing dependencies like `async-mutex` locally), and the configuration file in this folder.

Your directory should look like this:
```text
/path/to/your/llamacpp-resource-guard/
├── index.js                     # Your compiled plugin code
├── resource-guard-config.json   # The plugin's hardware configuration
└── package.json                 # (Optional) For installing async-mutex
```

## 2. Plugin Configuration (`resource-guard-config.json`)
This file tells the plugin how to communicate with your local LLM and which tools require a VRAM lock. Ensure this file is in the same directory as your `index.js`.
```json
{
  "llamaUrl": "[http://127.0.0.1:8080](http://127.0.0.1:8080)",
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

### What to change for your environment:
*   **`llamaUrl`**: The base URL and port where your `llama-server` is actively running.
*   **`localProviderId`**: The exact provider ID your OpenClaw agents use when routing requests to your local GPU. (Agents using different providers, like Claude or OpenAI, will bypass the lock).
*   **`heavyTools`**: Add the exact names of any OpenClaw tools/skills that require dedicated VRAM.
*   **`commands.start` & `commands.stop`**: Modify the shell commands under your specific operating system to match how you natively boot and kill your `llama-server` instance.

## 3. OpenClaw System Registration
To activate the plugin, you must tell OpenClaw where the folder is located and explicitly allow it to run.

Open your primary OpenClaw configuration file (usually `~/.openclaw/openclaw.json` or located in your workspace root). Add your plugin to both the `allow` list and the `entries` object.
```json
{
  "plugins": {
    "allow": [
      "llamacpp-resource-guard",
      "other-existing-plugins"
    ],
    "entries": {
      "llamacpp-resource-guard": {
        "enabled": true,
        "path": "/absolute/path/to/your/llamacpp-resource-guard"
      }
    }
  }
}
```
*Note: Replace `/absolute/path/to/...` with the actual path on your machine where you created the folder in Step 1.*

## 4. Usage & Verification
1.  **Start OpenClaw:** Restart your OpenClaw gateway so it reads the updated `openclaw.json` and loads the plugin.
2.  **Verify Telemetry:** Initiate a standard chat with an agent using your local model. You should see `[VRAM]` logs in your terminal confirming the hooks are tracking `activeLocalGenerations`.
3.  **Trigger the Lock:** Ask an agent to use one of the tools listed in your `heavyTools` array (e.g., `mock_heavy_tool`).
4.  **Observe the Handoff:**
    *   The terminal will log `[VRAM] Heavy tool queued. State -> DRAINING.`
    *   The plugin will wait for active text generation to finish, save the active slots to your OS temp directory, and kill the `llama-server`.
    *   The heavy tool will execute.
    *   The plugin will restart the `llama-server`, restore the KV cache slots, and unpause any agents that were waiting.
