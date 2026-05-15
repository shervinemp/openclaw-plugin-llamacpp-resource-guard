import { Mutex } from "async-mutex";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let CONFIG = {};
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

const platform = process.platform;
const CMD_START = CONFIG.commands.start[platform] || CONFIG.commands.start["linux"];
const CMD_STOP = CONFIG.commands.stop[platform] || CONFIG.commands.stop["linux"];

let gpuState = "IDLE";
let activeLocalGenerations = 0;
let savedSlotIds = [];

const orchestrationMutex = new Mutex();
const activeToolLocks = new Map();

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
    api.on("model_call_started", (event) => {
      if (event.provider === CONFIG.localProviderId) {
        activeLocalGenerations++;
      }
    });

    api.on("model_call_ended", (event) => {
      if (event.provider === CONFIG.localProviderId) {
        activeLocalGenerations = Math.max(0, activeLocalGenerations - 1);
      }
    });

    api.on("before_model_resolve", async (event, ctx) => {
      if (ctx.modelProviderId !== CONFIG.localProviderId) return;
      if (gpuState !== "IDLE") {
        console.info(`[VRAM] Gatekeeper paused run ${ctx.runId}. Waiting for GPU...`);
        while (gpuState !== "IDLE") {
          await sleep(100);
        }
      }
    }, { priority: 100 });

    api.on("before_tool_call", async (event, ctx) => {
      if (!CONFIG.heavyTools.includes(event.toolName)) return;

      const releaseMutex = await orchestrationMutex.acquire();
      const executionId = event.toolCallId || ctx.toolCallId;
      if (executionId) {
        activeToolLocks.set(executionId, releaseMutex);
      } else {
        releaseMutex();
        return;
      }

      console.info(`[VRAM] Heavy tool queued. State -> DRAINING.`);
      gpuState = "DRAINING";

      while (activeLocalGenerations > 0) {
        await sleep(100);
      }

      gpuState = "LOCKED";
      console.info(`[VRAM] GPU drained. State -> LOCKED. Saving active context slots...`);

      try {
        const res = await fetch(`${CONFIG.llamaUrl}/slots`);
        if (res.ok) {
          const slots = await res.json();
          savedSlotIds = [];
          for (const slot of slots) {
            if (slot.n_past > 0) {
              const filepath = path.join(SLOTS_DIR, `slot_${slot.id}.bin`);
              console.info(`[VRAM] Saving Slot ${slot.id} (${slot.n_past} tokens)...`);
              await fetch(`${CONFIG.llamaUrl}/slots/${slot.id}?action=save&filepath=${filepath}`, { method: 'POST' });
              savedSlotIds.push(slot.id);
            }
          }
        }
      } catch (e) {
        console.warn(`[VRAM] Warning: Could not reach Llama server to save slots.`);
      }

      console.info(`[VRAM] Killing local LLM process...`);
      try {
        await execAsync(CMD_STOP);
      } catch (e) {
        console.warn(`[VRAM] Warning: Stop command returned an error.`);
      }
    }, { priority: 100 });

    api.on("after_tool_call", async (event, ctx) => {
      if (!CONFIG.heavyTools.includes(event.toolName)) return;

      console.info(`[VRAM] Tool finished. Rebooting local LLM...`);
      await execAsync(CMD_START);

      let isHealthy = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`${CONFIG.llamaUrl}/health`);
          if (res.ok) { isHealthy = true; break; }
        } catch (e) {}
        await sleep(1000);
      }

      if (!isHealthy) {
        console.error(`[VRAM] CRITICAL: LLM failed to boot after 30 seconds!`);
      } else if (savedSlotIds.length > 0) {
        console.info(`[VRAM] LLM online. Restoring ${savedSlotIds.length} context slots...`);
        for (const id of savedSlotIds) {
          const filepath = path.join(SLOTS_DIR, `slot_${id}.bin`);
          try {
            await fetch(`${CONFIG.llamaUrl}/slots/${id}?action=restore&filepath=${filepath}`, { method: 'POST' });
            console.info(`[VRAM] Restored Slot ${id}`);
          } catch (e) {
            console.warn(`[VRAM] Failed to restore Slot ${id}`);
          }
        }
      }

      gpuState = "IDLE";
      savedSlotIds = [];

      const executionId = event.toolCallId || ctx.toolCallId;
      if (executionId && activeToolLocks.has(executionId)) {
        const releaseMutex = activeToolLocks.get(executionId);
        releaseMutex();
        activeToolLocks.delete(executionId);
      }

      console.info(`[VRAM] Swap complete. Local agents unpaused.`);
    }, { priority: 100 });
  }
});
