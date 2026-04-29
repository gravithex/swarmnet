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

const AGENT: AgentRole = "executor";

// ── env ───────────────────────────────────────────────────────────────────────
const AXL_NODE_URL = process.env.AXL_NODE_URL ?? "http://localhost:9002";
const PLANNER_PEER_ID = process.env.PLANNER_PEER_ID ?? "";
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "3004");

const KEEPERHUB_WORKFLOW_ID = process.env.KEEPERHUB_WORKFLOW_ID ?? "";
const KEEPERHUB_USER_API_KEY = process.env.KEEPERHUB_USER_API_KEY ?? "";
const KEEPERHUB_ORG_API_KEY = process.env.KEEPERHUB_ORG_API_KEY ?? "";
const KEEPERHUB_BASE_URL = process.env.KEEPERHUB_BASE_URL ?? "https://app.keeperhub.com/api/workflows";

const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? "";
const UNISWAP_CHAIN_ID = Number(process.env.UNISWAP_CHAIN_ID ?? "11155111");

const ZEROG_INDEXER_URL = process.env.ZEROG_INDEXER_URL ?? "";
const ZEROG_KV_URL = process.env.ZEROG_KV_URL ?? "";
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const ZEROG_PRIVATE_KEY = process.env.ZEROG_PRIVATE_KEY ?? "";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "";
const ZEROG_STREAM_ID = process.env.ZEROG_STREAM_ID ?? "";

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 20;

// ── clients ───────────────────────────────────────────────────────────────────
const axl = new AXLClient(AXL_NODE_URL);

const memory = new MemoryStore({
  indexerUrl: ZEROG_INDEXER_URL,
  kvClientUrl: ZEROG_KV_URL,
  blockchainRpc: ZEROG_RPC_URL,
  privateKey: ZEROG_PRIVATE_KEY,
  flowAddress: ZEROG_FLOW_ADDRESS,
  streamId: ZEROG_STREAM_ID,
});

// ── KeeperHub types ───────────────────────────────────────────────────────────
interface WebhookPayload {
  taskId: string;
  tokenIn: ResearchData["tokenIn"];
  tokenOut: ResearchData["tokenOut"];
  amountIn: string;
  fee: number;
  recipient: string;
  amountOutMinimum: number;
  sqrtPriceLimitX96: number;
}

interface WebhookResponse {
  executionId: string;
  status: string;
}

type ExecutionStatus = "pending" | "running" | "success" | "error" | "cancelled";

interface ExecutionStatusResponse {
  status: ExecutionStatus;
  nodeStatuses?: Array<{ nodeId: string; status: string }>;
  progress?: {
    totalSteps: number;
    completedSteps: number;
    runningSteps: number;
    currentNodeId: string;
    percentage: number;
  };
}

// ── KeeperHub API helpers ─────────────────────────────────────────────────────
async function triggerWebhook(payload: WebhookPayload, taskId: string): Promise<WebhookResponse> {
  const url = `${KEEPERHUB_BASE_URL}/${KEEPERHUB_WORKFLOW_ID}/webhook`;
  log(AGENT, "info", `Triggering KeeperHub webhook — ${url}`, taskId);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${KEEPERHUB_USER_API_KEY}`
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`KeeperHub webhook returned HTTP ${res.status}: ${body}`);
  }

  const data = await res.json() as WebhookResponse;
  log(AGENT, "info", `Webhook accepted — executionId=${data.executionId} status=${data.status}`, taskId);
  return data;
}

async function fetchExecutionStatus(executionId: string): Promise<ExecutionStatusResponse> {
  const url = `${KEEPERHUB_BASE_URL}/executions/${executionId}/status`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${KEEPERHUB_ORG_API_KEY}`
    },
  });
  if (!res.ok) {
    throw new Error(`Status fetch returned HTTP ${res.status}`);
  }
  return res.json() as Promise<ExecutionStatusResponse>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollUntilSettled(executionId: string, taskId: string): Promise<ExecutionStatusResponse> {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const statusRes = await fetchExecutionStatus(executionId);
    const pct = statusRes.progress?.percentage ?? "?";
    log(AGENT, "info", `Poll ${attempt}/${POLL_MAX_ATTEMPTS} executionId=${executionId} status=${statusRes.status} progress=${pct}%`, taskId);

    if (statusRes.status === "success" || statusRes.status === "error" || statusRes.status === "cancelled") {
      return statusRes;
    }
    if (attempt < POLL_MAX_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Execution not settled after ${POLL_MAX_ATTEMPTS} attempts (executionId=${executionId})`);
}

// ── APPROVE handler ───────────────────────────────────────────────────────────
async function handleApprove(msg: AgentMessage): Promise<void> {
  const { taskId } = msg;
  const payload = msg.payload as {
    researchKey?: string;
    planKey?: string;
    critiqueKey?: string;
    confidence?: number;
    researchData?: ResearchData;
  };

  const researchKey = payload?.researchKey ?? `research:${taskId}`;

  // 1. Research data travels inline in the AXL payload — no KV read needed.
  if (!payload?.researchData) {
    const errMsg = `APPROVE payload missing researchData (key=${researchKey})`;
    log(AGENT, "error", errMsg, taskId);
    await notifyError(taskId, errMsg);
    return;
  }
  const research: ResearchData = payload.researchData;
  log(AGENT, "info", `Research loaded — ${research.tokenIn.symbol}→${research.tokenOut.symbol} amountIn=${research.amountIn}`, taskId);

  // 2. Notify planner that execution has started.
  if (PLANNER_PEER_ID) {
    try {
      await axl.sendMessage(PLANNER_PEER_ID,
        createMessage("executor", "planner", "PROGRESS", { phase: "executing" }, taskId));
    } catch { /* best-effort */ }
  }

  // 3. Trigger KeeperHub workflow via webhook.
  const webhookPayload: WebhookPayload = {
    taskId,
    tokenIn: research.tokenIn,
    tokenOut: research.tokenOut,
    amountIn: research.amountIn,
    fee: 500,
    recipient: TREASURY_ADDRESS,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  };

  let executionId: string;
  try {
    const webhookRes = await triggerWebhook(webhookPayload, taskId);
    executionId = webhookRes.executionId;
  } catch (err) {
    log(AGENT, "error", `KeeperHub webhook failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 4. Notify planner the swap is being processed by KeeperHub.
  if (PLANNER_PEER_ID) {
    try {
      await axl.sendMessage(PLANNER_PEER_ID,
        createMessage("executor", "planner", "PROGRESS", { phase: "processing", executionId }, taskId));
    } catch { /* best-effort */ }
  }

  // 5. Poll until KeeperHub confirms success/error.
  let settled: ExecutionStatusResponse;
  try {
    settled = await pollUntilSettled(executionId, taskId);
  } catch (err) {
    log(AGENT, "error", `Polling exhausted: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  if (settled.status === "error" || settled.status === "cancelled") {
    log(AGENT, "error", `KeeperHub execution ${settled.status} — executionId=${executionId}`, taskId);
    await notifyError(taskId, `KeeperHub execution ${settled.status} (executionId=${executionId})`);
    return;
  }

  log(AGENT, "info", `KeeperHub execution success — executionId=${executionId}`, taskId);

  // 6. Persist execution record to 0G Storage.
  try {
    await memory.set(`execution:${taskId}`, {
      taskId,
      executionId,
      workflowId: KEEPERHUB_WORKFLOW_ID,
      chainId: UNISWAP_CHAIN_ID,
      tokenIn: research.tokenIn,
      tokenOut: research.tokenOut,
      amountIn: research.amountIn,
      status: "SUCCESS",
      executedAt: Date.now(),
    });
    log(AGENT, "info", `Execution record written to 0G Storage at execution:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G Storage write failed (non-fatal): ${toErrMsg(err)}`, taskId);
  }

  try {
    await memory.appendLog({
      event: "SUCCESS",
      taskId,
      executionId,
      workflowId: KEEPERHUB_WORKFLOW_ID,
      tokenIn: research.tokenIn.symbol,
      tokenOut: research.tokenOut.symbol,
      amountIn: research.amountIn,
      ts: Date.now(),
    });
  } catch (err) {
    log(AGENT, "warn", `appendLog failed (non-fatal): ${toErrMsg(err)}`, taskId);
  }

  // 7. Notify Planner — swap confirmed by KeeperHub.
  if (!PLANNER_PEER_ID) {
    log(AGENT, "warn", "PLANNER_PEER_ID not set — skipping AXL dispatch", taskId);
    return;
  }

  const doneMsg = createMessage("executor", "planner", "DONE", {
    executionId,
    workflowId: KEEPERHUB_WORKFLOW_ID,
    planKey: payload?.planKey,
    executionKey: `execution:${taskId}`,
  }, taskId);

  try {
    await axl.sendMessage(PLANNER_PEER_ID, doneMsg);
    log(AGENT, "info", `DONE dispatched to planner (peer=${PLANNER_PEER_ID})`, taskId);
  } catch (err) {
    log(AGENT, "error", `AXL sendMessage failed: ${toErrMsg(err)}`, taskId);
  }
}

// Send an ERROR message back to the Planner so it can react.
async function notifyError(taskId: string, detail: string): Promise<void> {
  if (!PLANNER_PEER_ID) return;
  try {
    const errMsg = createMessage("executor", "planner", "ERROR", { detail }, taskId);
    await axl.sendMessage(PLANNER_PEER_ID, errMsg);
  } catch {
    // best-effort; don't mask the original error
  }
}

// ── incoming message router ───────────────────────────────────────────────────
async function handleMessage(msg: AgentMessage): Promise<void> {
  if (msg.to !== AGENT && msg.to !== "broadcast") return;

  log(AGENT, "info", `Received ${msg.type} from ${msg.from}`, msg.taskId);

  if (msg.type === "APPROVE") {
    await handleApprove(msg);
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
      ["KEEPERHUB_WORKFLOW_ID", KEEPERHUB_WORKFLOW_ID],
      ["PLANNER_PEER_ID", PLANNER_PEER_ID],
      ["TREASURY_ADDRESS", TREASURY_ADDRESS],
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

main().catch((err: unknown) => {
  console.error(JSON.stringify({ agent: AGENT, level: "error", message: String(err) }));
  process.exit(1);
});
