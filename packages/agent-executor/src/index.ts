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

// KeeperHub workflow webhook — configure the workflow ID in .env.
const KEEPERHUB_WORKFLOW_ID = process.env.KEEPERHUB_WORKFLOW_ID ?? "";
const KEEPERHUB_BASE_URL = process.env.KEEPERHUB_BASE_URL ?? "https://app.keeperhub.com/api/workflows";

// Recipient of swap output tokens.
const SWAP_RECIPIENT = process.env.SWAP_RECIPIENT ?? "";
const UNISWAP_CHAIN_ID = Number(process.env.UNISWAP_CHAIN_ID ?? "11155111");

const ZEROG_INDEXER_URL = process.env.ZEROG_INDEXER_URL ?? "";
const ZEROG_KV_URL = process.env.ZEROG_KV_URL ?? "";
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const ZEROG_PRIVATE_KEY = process.env.ZEROG_PRIVATE_KEY ?? "";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "";
const ZEROG_STREAM_ID = process.env.ZEROG_STREAM_ID ?? "";

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

// ── KeeperHub webhook ─────────────────────────────────────────────────────────
interface WebhookPayload {
  taskId: string;
  goal: string;
  chainId: number;
  recipient: string;
  tokenIn: ResearchData["tokenIn"];
  tokenOut: ResearchData["tokenOut"];
  amountIn: string;
  amountOut: string;
  bestRoute: string;
  priceImpact: string;
  gasEstimate: string;
  gasEstimateUSD?: string;
}

async function triggerWebhook(payload: WebhookPayload, taskId: string): Promise<void> {
  const url = `${KEEPERHUB_BASE_URL}/${KEEPERHUB_WORKFLOW_ID}/webhook`;
  log(AGENT, "info", `Triggering KeeperHub webhook — ${url}`, taskId);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`KeeperHub webhook returned HTTP ${res.status}: ${body}`);
  }

  log(AGENT, "info", `Webhook accepted (HTTP ${res.status})`, taskId);
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
    goal: research.goal,
    chainId: UNISWAP_CHAIN_ID,
    recipient: SWAP_RECIPIENT,
    tokenIn: research.tokenIn,
    tokenOut: research.tokenOut,
    amountIn: research.amountIn,
    amountOut: research.amountOut,
    bestRoute: research.bestRoute,
    priceImpact: research.priceImpact,
    gasEstimate: research.gasEstimate,
    gasEstimateUSD: research.gasEstimateUSD,
  };

  try {
    await triggerWebhook(webhookPayload, taskId);
  } catch (err) {
    log(AGENT, "error", `KeeperHub webhook failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 4. Persist execution record to 0G Storage.
  try {
    await memory.set(`execution:${taskId}`, {
      taskId,
      webhookTriggered: true,
      workflowId: KEEPERHUB_WORKFLOW_ID,
      chainId: UNISWAP_CHAIN_ID,
      tokenIn: research.tokenIn,
      tokenOut: research.tokenOut,
      amountIn: research.amountIn,
      status: "TRIGGERED",
      executedAt: Date.now(),
    });
    log(AGENT, "info", `Execution record written to 0G Storage at execution:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G Storage write failed (non-fatal): ${toErrMsg(err)}`, taskId);
  }

  try {
    await memory.appendLog({
      event: "TRIGGERED",
      taskId,
      workflowId: KEEPERHUB_WORKFLOW_ID,
      tokenIn: research.tokenIn.symbol,
      tokenOut: research.tokenOut.symbol,
      amountIn: research.amountIn,
      ts: Date.now(),
    });
  } catch (err) {
    log(AGENT, "warn", `appendLog failed (non-fatal): ${toErrMsg(err)}`, taskId);
  }

  // 5. Notify Planner — webhook dispatched, KeeperHub takes it from here.
  if (!PLANNER_PEER_ID) {
    log(AGENT, "warn", "PLANNER_PEER_ID not set — skipping AXL dispatch", taskId);
    return;
  }

  const doneMsg = createMessage("executor", "planner", "DONE", {
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
      ["SWAP_RECIPIENT", SWAP_RECIPIENT],
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
