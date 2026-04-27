import { createServer } from "node:http";
import {
  AXLClient,
  MemoryStore,
  createMessage,
  log,
  toErrMsg,
  type AgentMessage,
  type AgentRole,
  type ResearchData,
} from "@swarmnet/shared";

const AGENT: AgentRole = "critic";

// ── env ───────────────────────────────────────────────────────────────────────
const AXL_NODE_URL = process.env.AXL_NODE_URL ?? "http://localhost:9002";
const EXECUTOR_PEER_ID = process.env.EXECUTOR_PEER_ID ?? "";
const PLANNER_PEER_ID = process.env.PLANNER_PEER_ID ?? "";
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "3003");

const ZEROG_INDEXER_URL = process.env.ZEROG_INDEXER_URL ?? "";
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const ZEROG_PRIVATE_KEY = process.env.ZEROG_PRIVATE_KEY ?? "";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "";
const ZEROG_STREAM_ID = process.env.ZEROG_STREAM_ID ?? "";

// ── clients ───────────────────────────────────────────────────────────────────
const axl = new AXLClient(AXL_NODE_URL);

const memory = new MemoryStore({
  indexerUrl: ZEROG_INDEXER_URL,
  blockchainRpc: ZEROG_RPC_URL,
  privateKey: ZEROG_PRIVATE_KEY,
  flowAddress: ZEROG_FLOW_ADDRESS,
  streamId: ZEROG_STREAM_ID,
});

// ── critique result stored in 0G ──────────────────────────────────────────────
interface CritiqueData {
  taskId: string;
  confidence: number;
  verdict: "APPROVE" | "REJECT";
  reason?: string;
  scoredAt: number;
}

// ── validation ────────────────────────────────────────────────────────────────
interface ValidationResult {
  confidence: number;
  reason: string;
}

function validate(research: ResearchData): ValidationResult {
  let confidence = 0;
  const failing: string[] = [];

  // priceImpact is a percentage string like "0.12" or "1.5".
  const priceImpact = parseFloat(research.priceImpact);
  if (!isNaN(priceImpact) && priceImpact < 0.5) {
    confidence += 0.3;
  } else {
    failing.push(`priceImpact ${research.priceImpact}% exceeds 0.5%`);
  }

  // gasEstimate is the raw gas units string; gasEstimateUSD is the USD cost.
  // We check gasEstimateUSD when available, otherwise treat as passing.
  const gasUSD = research.gasEstimateUSD !== undefined
    ? parseFloat(research.gasEstimateUSD)
    : NaN;
  const gasEthEquiv = isNaN(gasUSD)
    ? null
    : gasUSD / 3000; // rough ETH price denominator for sanity check
  if (gasEthEquiv === null || gasEthEquiv < 0.01) {
    confidence += 0.3;
  } else {
    failing.push(`gasEstimate USD ${research.gasEstimateUSD} exceeds ~0.01 ETH`);
  }

  if (research.bestRoute && research.bestRoute.length > 0) {
    confidence += 0.4;
  } else {
    failing.push("bestRoute is empty");
  }

  const reason = failing.length > 0 ? failing.join("; ") : undefined;
  return { confidence, reason: reason ?? "" };
}

// ── RESEARCH_DONE handler ─────────────────────────────────────────────────────
async function handleResearchDone(msg: AgentMessage): Promise<void> {
  const { taskId } = msg;
  const payload = msg.payload as {
    researchKey?: string;
    planKey?: string;
    summary?: unknown;
  };

  const researchKey = payload?.researchKey ?? `research:${taskId}`;
  log(AGENT, "info", `Processing RESEARCH_DONE — reading ${researchKey}`, taskId);

  // Notify planner that critiquing has started.
  if (PLANNER_PEER_ID) {
    try {
      await axl.sendMessage(PLANNER_PEER_ID,
        createMessage("critic", "planner", "PROGRESS", { phase: "critiquing" }, taskId));
    } catch { /* best-effort */ }
  }

  // 1. Read research data from 0G Storage.
  let research: ResearchData;
  try {
    const stored = await memory.get<ResearchData>(researchKey);
    if (stored === null) {
      throw new Error(`key ${researchKey} not found in 0G Storage`);
    }
    research = stored;
    log(AGENT, "info", `Research loaded — priceImpact=${research.priceImpact}% gasEstimate=${research.gasEstimate}`, taskId);
  } catch (err) {
    log(AGENT, "error", `Failed to read research: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 2. Run validation checks.
  const { confidence, reason } = validate(research);
  const verdict: "APPROVE" | "REJECT" = confidence >= 0.7 ? "APPROVE" : "REJECT";
  log(AGENT, "info", `Validation complete — confidence=${confidence.toFixed(2)} verdict=${verdict}`, taskId);

  // 3. Persist critique to 0G Storage.
  const critique: CritiqueData = {
    taskId,
    confidence,
    verdict,
    ...(verdict === "REJECT" && reason ? { reason } : {}),
    scoredAt: Date.now(),
  };

  try {
    await memory.set(`critique:${taskId}`, critique);
    log(AGENT, "info", `Critique written to 0G Storage at critique:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G unavailable — critique not persisted: ${toErrMsg(err)}`, taskId);
  }

  // 4. Append decision to shared log.
  try {
    await memory.appendLog({
      event: verdict,
      taskId,
      confidence,
      ...(reason ? { reason } : {}),
      ts: Date.now(),
    });
  } catch (err) {
    log(AGENT, "warn", `appendLog failed (non-fatal): ${toErrMsg(err)}`, taskId);
  }

  // 5. Dispatch verdict via AXL.
  if (verdict === "APPROVE") {
    if (!EXECUTOR_PEER_ID) {
      log(AGENT, "warn", "EXECUTOR_PEER_ID not set — skipping AXL dispatch", taskId);
      return;
    }
    const approveMsg = createMessage("critic", "executor", "APPROVE", {
      researchKey,
      planKey: payload?.planKey,
      critiqueKey: `critique:${taskId}`,
      confidence,
    }, taskId);
    try {
      await axl.sendMessage(EXECUTOR_PEER_ID, approveMsg);
      log(AGENT, "info", `APPROVE dispatched to executor (peer=${EXECUTOR_PEER_ID})`, taskId);
    } catch (err) {
      log(AGENT, "error", `AXL sendMessage failed: ${toErrMsg(err)}`, taskId);
      await notifyError(taskId, toErrMsg(err));
    }
  } else {
    if (!PLANNER_PEER_ID) {
      log(AGENT, "warn", "PLANNER_PEER_ID not set — skipping AXL dispatch", taskId);
      return;
    }
    const rejectMsg = createMessage("critic", "planner", "REJECT", {
      critiqueKey: `critique:${taskId}`,
      planKey: payload?.planKey,
      confidence,
      reason,
    }, taskId);
    try {
      await axl.sendMessage(PLANNER_PEER_ID, rejectMsg);
      log(AGENT, "info", `REJECT dispatched to planner (peer=${PLANNER_PEER_ID}) reason="${reason}"`, taskId);
    } catch (err) {
      log(AGENT, "error", `AXL sendMessage failed: ${toErrMsg(err)}`, taskId);
    }
  }
}

// Send an ERROR message back to the Planner so it can react.
async function notifyError(taskId: string, detail: string): Promise<void> {
  if (!PLANNER_PEER_ID) return;
  try {
    const errMsg = createMessage("critic", "planner", "ERROR", { detail }, taskId);
    await axl.sendMessage(PLANNER_PEER_ID, errMsg);
  } catch {
    // best-effort; don't mask the original error
  }
}

// ── incoming message router ───────────────────────────────────────────────────
async function handleMessage(msg: AgentMessage): Promise<void> {
  if (msg.to !== AGENT && msg.to !== "broadcast") return;

  log(AGENT, "info", `Received ${msg.type} from ${msg.from}`, msg.taskId);

  if (msg.type === "RESEARCH_DONE") {
    await handleResearchDone(msg);
    return;
  }

  log(AGENT, "warn", `Unhandled message type: ${msg.type}`, msg.taskId);
}

// ── health server ─────────────────────────────────────────────────────────────
function startHealthServer(): void {
  createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agent: AGENT }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(HEALTH_PORT, () => {
    log(AGENT, "info", `Health server listening on port ${HEALTH_PORT}`);
  });
}

// ── startup ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const missing = (
    [
      ["EXECUTOR_PEER_ID", EXECUTOR_PEER_ID],
      ["ZEROG_RPC_URL", ZEROG_RPC_URL],
      ["ZEROG_PRIVATE_KEY", ZEROG_PRIVATE_KEY],
      ["ZEROG_FLOW_ADDRESS", ZEROG_FLOW_ADDRESS],
      ["ZEROG_STREAM_ID", ZEROG_STREAM_ID],
    ] as [string, string][]
  ).filter(([, v]) => v === "");

  if (missing.length > 0) {
    log(AGENT, "warn", `Missing env vars: ${missing.map(([k]) => k).join(", ")}`);
  }

  let peerId: string;
  try {
    peerId = await axl.getPeerId();
    log(AGENT, "info", `Connected to AXL — peer id: ${peerId}`);
  } catch (err) {
    log(AGENT, "error", `AXL connection failed: ${toErrMsg(err)}`);
    process.exit(1);
  }

  axl.onMessage(handleMessage);
  log(AGENT, "info", "Subscribed to AXL message stream");

  startHealthServer();

  const shutdown = (): void => {
    log(AGENT, "info", "Shutting down");
    axl.stopPolling();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// main().catch((err: unknown) => {
//   console.error(JSON.stringify({ agent: AGENT, level: "error", message: String(err) }));
//   process.exit(1);
// });

memory.get("research:23198ee1-e833-4ca5-b102-1c0359e44788")
  .then(val => console.log("result:", JSON.stringify(val, null, 2)))
  .catch(err => console.error("error:", toErrMsg(err)));
