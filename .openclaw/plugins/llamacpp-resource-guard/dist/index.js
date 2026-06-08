import { Mutex } from "async-mutex";
import { exec, spawn, execSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fileURLToPath } from "url";
const execAsync = promisify(exec);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// --- Helpers ---
class FetchError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.name = "FetchError";
        this.statusCode = statusCode;
    }
}
async function fetchWithTimeout(url, options = {}) {
    const { timeout = 10000, ...fetchOptions } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...fetchOptions, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchWithCheck(url, options = {}) {
    const res = await fetchWithTimeout(url, options);
    if (!res.ok) {
        throw new FetchError(`HTTP ${res.status}`, res.status);
    }
    return res;
}
const LOG_FILE = path.join(os.tmpdir(), "vram-plugin-test.log");
const LOG = (msg) => fs.appendFileSync(LOG_FILE, msg + "\n");
let serverPid;
const SPWN_LOG_FILE = path.join(os.tmpdir(), "vram-spawn-errors.log");
function startLLM(command) {
    if (isProcessAlive("llama-server")) {
        LOG(`[VRAM] llama-server is already running, skipping start.`);
        return false;
    }
    const stderrStream = fs.createWriteStream(SPWN_LOG_FILE, { flags: "a" });
    const child = spawn(command, [], {
        shell: true,
        detached: true,
        stdio: ["ignore", "ignore", stderrStream],
        cwd: CONFIG.cwd?.[process.platform],
    });
    serverPid = child.pid;
    child.on("exit", (code, signal) => {
        stderrStream.end();
        serverPid = undefined;
        if (code !== 0 && code !== null) {
            LOG(`[VRAM] llama-server exited with code ${code} (signal: ${signal}). Check ${SPWN_LOG_FILE} for details.`);
        }
    });
    child.on("error", (err) => {
        LOG(`[VRAM] Failed to spawn llama-server: ${err.message}. Check ${SPWN_LOG_FILE} for details.`);
    });
    child.unref();
    return true;
}
function isProcessAlive(processName) {
    if (serverPid !== undefined) {
        try {
            process.kill(serverPid, 0);
            return true;
        }
        catch {
            serverPid = undefined;
        }
    }
    try {
        if (process.platform === "win32") {
            const name = processName.endsWith(".exe") ? processName : `${processName}.exe`;
            const out = execSync(`tasklist /NH /FI "IMAGENAME eq ${name}"`, {
                encoding: "utf8",
                timeout: 2000,
            });
            return out.includes(name);
        }
        const out = execSync(`pgrep "${processName}"`, { encoding: "utf8", timeout: 2000 });
        return out.trim().length > 0;
    }
    catch {
        return false;
    }
}
function loadConfig() {
    const configPath = path.resolve(__dirname, "..", "resource-guard-config.json");
    try {
        const rawData = fs.readFileSync(configPath, "utf-8");
        return JSON.parse(rawData);
    }
    catch (error) {
        LOG(`[VRAM] Failed to load config from ${configPath}`);
        process.exit(1);
    }
}
function resolvePlatformCommand(cmds) {
    const platform = process.platform;
    if (cmds[platform])
        return cmds[platform];
    if (platform === "win32") {
        throw new Error(`No command configured for platform: ${platform}`);
    }
    if (cmds["linux"])
        return cmds["linux"];
    throw new Error(`No command configured for platform "${platform}" and no linux fallback`);
}
async function acquireMutexWithTimeout(mutex, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Mutex acquire timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        mutex
            .acquire()
            .then((release) => {
            clearTimeout(timer);
            resolve(release);
        })
            .catch((err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
// --- Load config once at startup ---
const CONFIG = loadConfig();
const SLOTS_DIR = path.join(os.tmpdir(), "llama_slots");
if (!fs.existsSync(SLOTS_DIR)) {
    fs.mkdirSync(SLOTS_DIR, { recursive: true });
}
const CMD_START = resolvePlatformCommand(CONFIG.commands.start);
const CMD_STOP = resolvePlatformCommand(CONFIG.commands.stop);
// --- State ---
let gpuState = "IDLE";
let activeLocalGenerations = 0;
let savedSlotIds = [];
const orchestrationMutex = new Mutex();
const activeToolLocks = new Map();
const MUTEX_TIMEOUT = 120_000; // max time a tool can hold the mutex (watchdog)
const GENERATION_DRAIN_TIMEOUT = 60_000; // max time to wait for generations to finish
// --- Plugin entry ---
export default definePluginEntry({
    id: "llamacpp-resource-guard",
    name: "Llama.cpp Resource Guard",
    description: "Pauses local llama.cpp generation, saves KV cache slots, and frees VRAM when heavy tools are invoked.",
    configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
    },
    register(api) {
        // Shutdown: sync for process signals (can't await), async for gateway_stop
        const stopServerSync = () => {
            try {
                execSync(CMD_STOP, { stdio: "ignore", timeout: 5000 });
                LOG(`[VRAM] llama-server stopped.`);
            }
            catch { }
        };
        const stopServer = async () => {
            LOG(`[VRAM] OpenClaw shutting down. Killing llama-server...`);
            try {
                await execAsync(CMD_STOP, { timeout: 5000 });
                LOG(`[VRAM] llama-server stopped successfully.`);
            }
            catch (e) {
                LOG(`[VRAM] Stop command result: ${e.message}`);
            }
        };
        process.on("SIGINT", () => { stopServerSync(); process.exit(0); });
        process.on("SIGTERM", () => { stopServerSync(); process.exit(0); });
        process.on("exit", stopServerSync);
        api.on("gateway_stop", stopServer);
        // Validate config: log provider ID at startup so misconfiguration is visible
        LOG(`[VRAM] Config: provider="${CONFIG.localProviderId}"  url="${CONFIG.llamaUrl}"  tools=${JSON.stringify(CONFIG.heavyTools)}`);
        // Start server (spawn checks if already running)
        LOG(`[VRAM] Starting llama-server...`);
        startLLM(CMD_START);
        (async () => {
            for (let i = 0; i < 30; i++) {
                try {
                    const res = await fetchWithTimeout(`${CONFIG.llamaUrl}/health`, { timeout: 2000 });
                    if (res.ok) {
                        LOG(`[VRAM] llama-server is healthy after ${i + 1}s.`);
                        return;
                    }
                }
                catch { }
                await sleep(1000);
            }
            LOG(`[VRAM] WARNING: llama-server not healthy after 30s. Check your start command.`);
        })();
        // Track active local generations
        const onModelCallStarted = (event) => {
            if (event.provider === CONFIG.localProviderId) {
                activeLocalGenerations++;
                LOG(`[VRAM] model_call_started: activeLocalGenerations=${activeLocalGenerations}`);
            }
        };
        const onModelCallEnded = (event) => {
            if (event.provider === CONFIG.localProviderId) {
                activeLocalGenerations = Math.max(0, activeLocalGenerations - 1);
                LOG(`[VRAM] model_call_ended: activeLocalGenerations=${activeLocalGenerations}`);
            }
        };
        api.on("model_call_started", onModelCallStarted);
        api.on("model_call_ended", onModelCallEnded);
        // Gate local model resolve while GPU is draining
        api.on("before_model_resolve", async (event, ctx) => {
            if (ctx.modelProviderId !== CONFIG.localProviderId)
                return;
            if (gpuState !== "IDLE") {
                LOG(`[VRAM] Gatekeeper paused run ${ctx.runId ?? "(unknown)"}. Waiting for GPU...`);
                const deadline = Date.now() + GENERATION_DRAIN_TIMEOUT;
                while (gpuState !== "IDLE") {
                    if (Date.now() > deadline) {
                        LOG(`[VRAM] Gatekeeper timed out waiting for GPU. Allowing run anyway.`);
                        break;
                    }
                    await sleep(100);
                }
            }
        }, { priority: 100 });
        // Drain GPU + save slots before a heavy tool
        api.on("before_tool_call", async (event, ctx) => {
            if (!CONFIG.heavyTools.includes(event.toolName))
                return;
            // Acquire mutex (with timeout to prevent deadlock)
            let releaseMutex;
            try {
                releaseMutex = await acquireMutexWithTimeout(orchestrationMutex, MUTEX_TIMEOUT);
            }
            catch {
                LOG(`[VRAM] CRITICAL: Could not acquire orchestration mutex after ${MUTEX_TIMEOUT / 1000}s. Proceeding without lock to avoid deadlock.`);
                releaseMutex = () => { };
            }
            // Watchdog: release the mutex if after_tool_call is never invoked
            let mutexReleased = false;
            const watchdogTimer = setTimeout(() => {
                if (!mutexReleased) {
                    mutexReleased = true;
                    releaseMutex();
                    activeToolLocks.delete(lockKey);
                    gpuState = "IDLE";
                    LOG(`[VRAM] MUTEX WATCHDOG: Force-released lock after ${MUTEX_TIMEOUT / 1000}s. GPU state reset to IDLE.`);
                }
            }, MUTEX_TIMEOUT);
            const buildRelease = () => {
                if (!mutexReleased) {
                    mutexReleased = true;
                    clearTimeout(watchdogTimer);
                    releaseMutex();
                }
            };
            // Determine a lock key so after_tool_call can find and release this lock
            const executionId = event.toolCallId || ctx.toolCallId;
            const lockKey = executionId || "__fallback__";
            // If a stale lock exists for this key (e.g. watchdog already freed a previous one), replace it
            activeToolLocks.set(lockKey, buildRelease);
            LOG(`[VRAM] Heavy tool queued. State -> DRAINING. activeLocalGenerations=${activeLocalGenerations}`);
            gpuState = "DRAINING";
            // Wait for active generations, with a safety timeout
            const drainDeadline = Date.now() + GENERATION_DRAIN_TIMEOUT;
            while (activeLocalGenerations > 0) {
                if (Date.now() > drainDeadline) {
                    LOG(`[VRAM] WARNING: Timed out waiting for ${activeLocalGenerations} active generation(s) after ${GENERATION_DRAIN_TIMEOUT / 1000}s. Proceeding anyway.`);
                    break;
                }
                await sleep(100);
            }
            gpuState = "LOCKED";
            LOG(`[VRAM] GPU drained. State -> LOCKED. Saving active context slots...`);
            // Save active slots
            try {
                const res = await fetchWithTimeout(`${CONFIG.llamaUrl}/slots`, { timeout: 5000 });
                if (res.ok) {
                    const slots = await res.json();
                    savedSlotIds = [];
                    for (const slot of slots) {
                        if (typeof slot.id !== "number") {
                            LOG(`[VRAM] Warning: slot has non-numeric id (${JSON.stringify(slot.id)}), skipping.`);
                            continue;
                        }
                        const tokenCount = slot.next_token?.n_decoded || slot.n_past || 0;
                        if (tokenCount > 0) {
                            const filepath = path.join(SLOTS_DIR, `slot_${slot.id}.bin`);
                            LOG(`[VRAM] Saving Slot ${slot.id} (${tokenCount} tokens)...`);
                            try {
                                await fetchWithCheck(`${CONFIG.llamaUrl}/slots/${slot.id}?action=save&filepath=${encodeURIComponent(filepath)}`, { method: "POST", timeout: 10000 });
                                savedSlotIds.push(slot.id);
                            }
                            catch (saveErr) {
                                LOG(`[VRAM] Failed to save Slot ${slot.id}: ${saveErr.message}`);
                            }
                        }
                    }
                }
            }
            catch (e) {
                LOG(`[VRAM] Warning: Could not reach Llama server to list slots: ${e.message}`);
            }
            // Kill local LLM
            LOG(`[VRAM] Killing local LLM process...`);
            try {
                await execAsync(CMD_STOP, { timeout: 5000 });
                LOG(`[VRAM] llama-server stopped successfully.`);
            }
            catch (e) {
                LOG(`[VRAM] Stop command result: ${e.message}`);
            }
        }, { priority: 100 });
        // Restart LLM and restore slots after heavy tool completes
        api.on("after_tool_call", async (event, ctx) => {
            if (!CONFIG.heavyTools.includes(event.toolName))
                return;
            LOG(`[VRAM] Tool finished. Rebooting local LLM...`);
            if (startLLM(CMD_START)) {
                LOG(`[VRAM] Start command issued.`);
            }
            const MAX_POLL = 60;
            const MAX_POLL_WITHOUT_PROCESS = 5;
            let isHealthy = false;
            let bailedEarly = false;
            for (let i = 0; i < MAX_POLL; i++) {
                if (!isProcessAlive("llama-server") && i >= MAX_POLL_WITHOUT_PROCESS) {
                    LOG(`[VRAM] llama-server process not found after ${i + 1}s, aborting poll.`);
                    bailedEarly = true;
                    break;
                }
                try {
                    const res = await fetchWithTimeout(`${CONFIG.llamaUrl}/health`, { timeout: 2000 });
                    if (res.ok) {
                        isHealthy = true;
                        break;
                    }
                }
                catch {
                    // not healthy yet
                }
                await sleep(1000);
            }
            if (!isHealthy) {
                if (bailedEarly) {
                    LOG(`[VRAM] CRITICAL: llama-server process not running after ${MAX_POLL_WITHOUT_PROCESS}s.`);
                }
                else {
                    LOG(`[VRAM] CRITICAL: llama-server failed to become healthy within ${MAX_POLL}s.`);
                }
            }
            else {
                LOG(`[VRAM] LLM online (healthy).`);
                if (savedSlotIds.length > 0) {
                    LOG(`[VRAM] Restoring ${savedSlotIds.length} context slots...`);
                    for (const id of savedSlotIds) {
                        const filepath = path.join(SLOTS_DIR, `slot_${id}.bin`);
                        try {
                            await fetchWithCheck(`${CONFIG.llamaUrl}/slots/${id}?action=restore&filepath=${encodeURIComponent(filepath)}`, { method: "POST", timeout: 10000 });
                            LOG(`[VRAM] Restored Slot ${id}`);
                        }
                        catch (e) {
                            LOG(`[VRAM] Failed to restore Slot ${id}: ${e.message}`);
                        }
                    }
                }
            }
            gpuState = "IDLE";
            savedSlotIds = [];
            // Release the mutex lock for this tool
            const executionId = event.toolCallId || ctx.toolCallId;
            const lockKey = (executionId && activeToolLocks.has(executionId)) ? executionId : "__fallback__";
            if (activeToolLocks.has(lockKey)) {
                const releaseFn = activeToolLocks.get(lockKey);
                releaseFn();
                activeToolLocks.delete(lockKey);
            }
            if (executionId && lockKey !== executionId && activeToolLocks.has(executionId)) {
                activeToolLocks.delete(executionId);
            }
            LOG(`[VRAM] Swap complete. Local agents unpaused. state=IDLE`);
        }, { priority: 100 });
    },
});
