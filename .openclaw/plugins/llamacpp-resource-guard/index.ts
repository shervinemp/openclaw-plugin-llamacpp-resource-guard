import { Mutex } from "async-mutex";
import { exec, spawn, execSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startLLM(command: string) {
  const child = spawn(command, [], { shell: true, detached: true, stdio: "ignore" });
  child.unref();
}

let CONFIG: any = {};
try {
  const configPath = path.resolve(__dirname, "..", "resource-guard-config.json");
  const rawData = fs.readFileSync(configPath, "utf-8");
  CONFIG = JSON.parse(rawData);
} catch (error) {
  console.error("[VRAM] Failed to load resource-guard-config.json");
  process.exit(1);
}

const SLOTS_DIR = path.join(os.tmpdir(), "llama_slots");
if (!fs.existsSync(SLOTS_DIR)) {
  fs.mkdirSync(SLOTS_DIR, { recursive: true });
}

const platform = process.platform as "win32" | "darwin" | "linux";
const CMD_START = CONFIG.commands.start[platform] || CONFIG.commands.start["linux"];
const CMD_STOP = CONFIG.commands.stop[platform] || CONFIG.commands.stop["linux"];

let gpuState: "IDLE" | "DRAINING" | "LOCKED" = "IDLE";
let activeLocalGenerations = 0;
let savedSlotIds: number[] = [];

const orchestrationMutex = new Mutex();
const activeToolLocks = new Map<string, () => void>();

const LOG_FILE = path.join(os.tmpdir(), "vram-plugin-test.log");
const LOG = (msg: string) => fs.appendFileSync(LOG_FILE, msg + "\n");

export default definePluginEntry({
  id: "llamacpp-resource-guard",
  name: "Llama.cpp Resource Guard",
  description: "Pauses local llama.cpp generation, saves KV cache slots, and frees VRAM when heavy tools are invoked.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  register(api) {
    // Auto-start model on OpenClaw boot
    LOG(`[VRAM] OpenClaw starting. Auto-starting llama-server...`);
    startLLM(CMD_START);

    // Auto-stop model on OpenClaw shutdown
    let hasShutDown = false;
    const shutdownModel = () => {
      if (hasShutDown) return;
      hasShutDown = true;
      LOG(`[VRAM] OpenClaw shutting down. Killing llama-server...`);
      try {
        execSync(CMD_STOP, { stdio: "ignore", timeout: 5000 });
        LOG(`[VRAM] llama-server stopped successfully on exit.`);
      } catch (e: any) {
        LOG(`[VRAM] Stop command result on exit: ${e.message}`);
      }
    };
    process.once("SIGINT", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));
    process.on("exit", shutdownModel);

    api.on("model_call_started", (event: any) => {
      if (event.provider === CONFIG.localProviderId) {
        activeLocalGenerations++;
        LOG(`[VRAM] model_call_started: activeLocalGenerations=${activeLocalGenerations}`);
      }
    });

    api.on("model_call_ended", (event: any) => {
      if (event.provider === CONFIG.localProviderId) {
        activeLocalGenerations = Math.max(0, activeLocalGenerations - 1);
        LOG(`[VRAM] model_call_ended: activeLocalGenerations=${activeLocalGenerations}`);
      }
    });

    api.on("before_model_resolve", async (event: any, ctx: any) => {
      if (ctx.modelProviderId !== CONFIG.localProviderId) return;
      if (gpuState !== "IDLE") {
        LOG(`[VRAM] Gatekeeper paused run ${ctx.runId}. Waiting for GPU...`);
        while ((gpuState as string) !== "IDLE") {
          await sleep(100);
        }
      }
    }, { priority: 100 });

    api.on("before_tool_call", async (event: any, ctx: any) => {
      if (!CONFIG.heavyTools.includes(event.toolName)) return;

      const releaseMutex = await orchestrationMutex.acquire();
      const executionId = event.toolCallId || ctx.toolCallId;
      if (executionId) {
        activeToolLocks.set(executionId, releaseMutex);
      } else {
        releaseMutex();
        return;
      }

      LOG(`[VRAM] Heavy tool queued. State -> DRAINING. activeLocalGenerations=${activeLocalGenerations}`);
      gpuState = "DRAINING";

      while (activeLocalGenerations > 0) {
        await sleep(100);
      }

      gpuState = "LOCKED";
      LOG(`[VRAM] GPU drained. State -> LOCKED. Saving active context slots...`);

      try {
        const res = await fetch(`${CONFIG.llamaUrl}/slots`);
        if (res.ok) {
          const slots = await res.json();
          savedSlotIds = [];
          for (const slot of slots) {
            const tokenCount = slot.next_token?.n_decoded || slot.n_past || 0;
            if (tokenCount > 0) {
              const filepath = path.join(SLOTS_DIR, `slot_${slot.id}.bin`);
              LOG(`[VRAM] Saving Slot ${slot.id} (${tokenCount} tokens)...`);
              await fetch(`${CONFIG.llamaUrl}/slots/${slot.id}?action=save&filepath=${filepath}`, { method: 'POST' });
              savedSlotIds.push(slot.id);
            }
          }
        }
      } catch (e: any) {
        LOG(`[VRAM] Warning: Could not reach Llama server to save slots: ${e.message}`);
      }

      LOG(`[VRAM] Killing local LLM process...`);
      try {
        await execAsync(CMD_STOP);
        LOG(`[VRAM] llama-server stopped successfully.`);
      } catch (e: any) {
        LOG(`[VRAM] Stop command result: ${e.message}`);
      }
    }, { priority: 100 });

    api.on("after_tool_call", async (event: any, ctx: any) => {
      if (!CONFIG.heavyTools.includes(event.toolName)) return;

      LOG(`[VRAM] Tool finished. Rebooting local LLM (detached)...`);
      startLLM(CMD_START);
      LOG(`[VRAM] Start command issued.`);

      const MAX_POLL_WITH_PROCESS = 300;
      const MAX_POLL_WITHOUT_PROCESS = 3;
      let isHealthy = false;
      for (let i = 0; i < MAX_POLL_WITH_PROCESS; i++) {
        const processAlive = (() => {
          try {
            const out = execSync('tasklist /NH /FI "IMAGENAME eq llama-server.exe"', { encoding: "utf8", timeout: 2000 });
            return out.includes("llama-server.exe");
          } catch (e) { return false; }
        })();
        if (!processAlive && i >= MAX_POLL_WITHOUT_PROCESS) {
          LOG(`[VRAM] Process not found after ${i}s, aborting poll.`);
          break;
        }
        try {
          const res = await fetch(`${CONFIG.llamaUrl}/health`);
          if (res.ok) { isHealthy = true; break; }
        } catch (e) {}
        await sleep(1000);
      }

      if (!isHealthy) {
        LOG(`[VRAM] CRITICAL: LLM failed to boot (process was ${isHealthy ? "running" : "dead"} after poll).`);
      } else {
        LOG(`[VRAM] LLM online (healthy).`);
        if (savedSlotIds.length > 0) {
          LOG(`[VRAM] Restoring ${savedSlotIds.length} context slots...`);
          for (const id of savedSlotIds) {
            const filepath = path.join(SLOTS_DIR, `slot_${id}.bin`);
            try {
              await fetch(`${CONFIG.llamaUrl}/slots/${id}?action=restore&filepath=${filepath}`, { method: 'POST' });
              LOG(`[VRAM] Restored Slot ${id}`);
            } catch (e: any) {
              LOG(`[VRAM] Failed to restore Slot ${id}: ${e.message}`);
            }
          }
        }
      }

      gpuState = "IDLE";
      savedSlotIds = [];

      const executionId = event.toolCallId || ctx.toolCallId;
      if (executionId && activeToolLocks.has(executionId)) {
        const releaseMutex = activeToolLocks.get(executionId)!;
        releaseMutex();
        activeToolLocks.delete(executionId);
      }

      LOG(`[VRAM] Swap complete. Local agents unpaused. state=IDLE`);
    }, { priority: 100 });
  }
});
