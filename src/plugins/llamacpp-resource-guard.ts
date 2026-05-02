import { Mutex } from "async-mutex";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Adjust this import path based on your actual source tree
import type {
  PluginHookRegistration,
  PluginHookModelCallStartedEvent,
  PluginHookModelCallEndedEvent,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookToolContext
} from "../pi-hooks/hook-types.js";

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------
// CONFIGURATION LOADER & CROSS-PLATFORM PATHS
// ---------------------------------------------------------
let CONFIG: any = {};
try {
  const configPath = path.resolve(process.cwd(), "vram-config.json");
  const rawData = fs.readFileSync(configPath, "utf-8");
  CONFIG = JSON.parse(rawData);
} catch (error) {
  console.error("[VRAM] Failed to load vram-config.json! Make sure it exists in the workspace root.");
  process.exit(1);
}

// Cross-platform temp directory (e.g., C:\Users\Name\AppData\Local\Temp\llama_slots on Windows)
const SLOTS_DIR = path.join(os.tmpdir(), "llama_slots");
if (!fs.existsSync(SLOTS_DIR)) {
  fs.mkdirSync(SLOTS_DIR, { recursive: true });
}

// OS-aware command routing
const platform = process.platform as "win32" | "darwin" | "linux";
const CMD_START = CONFIG.commands.start[platform] || CONFIG.commands.start["linux"];
const CMD_STOP = CONFIG.commands.stop[platform] || CONFIG.commands.stop["linux"];

// ---------------------------------------------------------
// GLOBAL STATE MACHINE
// ---------------------------------------------------------
let gpuState: "IDLE" | "DRAINING" | "LOCKED" = "IDLE";
let activeLocalGenerations = 0;
let savedSlotIds: number[] = [];

const orchestrationMutex = new Mutex();
const activeToolLocks = new Map<string, () => void>();

// ---------------------------------------------------------
// HOOK REGISTRATIONS
// ---------------------------------------------------------
export const vramOrchestratorHooks: PluginHookRegistration[] = [

  // 1. TRACKING: Start
  {
    pluginId: "llamacpp-resource-guard",
    hookName: "model_call_started",
    source: "llamacpp-resource-guard",
    handler: (event: PluginHookModelCallStartedEvent, ctx: PluginHookAgentContext) => {
      if (event.provider === CONFIG.localProviderId) {
        activeLocalGenerations++;
      }
    }
  },

  // 2. TRACKING: End
  {
    pluginId: "llamacpp-resource-guard",
    hookName: "model_call_ended",
    source: "llamacpp-resource-guard",
    handler: (event: PluginHookModelCallEndedEvent, ctx: PluginHookAgentContext) => {
      if (event.provider === CONFIG.localProviderId) {
        activeLocalGenerations = Math.max(0, activeLocalGenerations - 1);
      }
    }
  },

  // 3. GATEKEEPER: Prevent reader starvation and pause local models
  {
    pluginId: "llamacpp-resource-guard",
    hookName: "before_model_resolve",
    source: "llamacpp-resource-guard",
    handler: async (event: PluginHookBeforeModelResolveEvent, ctx: PluginHookAgentContext) => {
      // Instantly bypass for Claude, OpenAI, etc.
      if (ctx.modelProviderId !== CONFIG.localProviderId) return;

      if (gpuState !== "IDLE") {
        console.info(`[VRAM] Gatekeeper paused run ${ctx.runId}. Waiting for GPU...`);
        while (gpuState !== "IDLE") {
          await sleep(100);
        }
      }
    }
  },

  // 4. DRAIN & LOCK: Save slots and shut down server
  {
    pluginId: "llamacpp-resource-guard",
    hookName: "before_tool_call",
    source: "llamacpp-resource-guard",
    priority: 100,
    handler: async (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
      if (!CONFIG.heavyTools.includes(event.toolName)) return;

      const releaseMutex = await orchestrationMutex.acquire();

      const executionId = event.toolCallId || ctx.toolCallId;
      if (executionId) {
        activeToolLocks.set(executionId, releaseMutex);
      } else {
        releaseMutex();
        return; // Safety fallback
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
            // Only save slots that actually contain past context tokens
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
        console.warn(`[VRAM] Warning: Stop command returned an error (server may already be dead).`);
      }
    }
  },

  // 5. RESTORE & UNLOCK: Reboot server and inject slots back into VRAM
  {
    pluginId: "llamacpp-resource-guard",
    hookName: "after_tool_call",
    source: "llamacpp-resource-guard",
    priority: 100,
    handler: async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
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
        const releaseMutex = activeToolLocks.get(executionId)!;
        releaseMutex();
        activeToolLocks.delete(executionId);
      }

      console.info(`[VRAM] Swap complete. Local agents unpaused.`);
    }
  }
];