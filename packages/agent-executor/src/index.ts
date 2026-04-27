import { createServer } from "node:http";
import axios from "axios";
import { ethers } from "ethers";
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

const KEEPERHUB_API_KEY = process.env.KEEPERHUB_API_KEY ?? "";
const KEEPERHUB_API_URL = process.env.KEEPERHUB_API_URL ?? "https://api.keeperhub.com";

const UNISWAP_CHAIN_ID = Number(process.env.UNISWAP_CHAIN_ID ?? "11155111");
// Recipient of swap output tokens — should be the treasury/EOA wallet.
const SWAP_RECIPIENT = process.env.SWAP_RECIPIENT ?? "";
const EXECUTOR_WALLET_ADDRESS = process.env.EXECUTOR_WALLET_ADDRESS ?? "";

const ZEROG_INDEXER_URL = process.env.ZEROG_INDEXER_URL ?? "";
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const ZEROG_PRIVATE_KEY = process.env.ZEROG_PRIVATE_KEY ?? "";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "";
const ZEROG_STREAM_ID = process.env.ZEROG_STREAM_ID ?? "";

// Uniswap V3 SwapRouter on Sepolia.
const UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const UNISWAP_POOL_FEE = 3000; // 0.3 % — matches the USDC/WETH Sepolia pool

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 10;

// ── clients ───────────────────────────────────────────────────────────────────
const axl = new AXLClient(AXL_NODE_URL);

const memory = new MemoryStore({
  indexerUrl: ZEROG_INDEXER_URL,
  blockchainRpc: ZEROG_RPC_URL,
  privateKey: ZEROG_PRIVATE_KEY,
  flowAddress: ZEROG_FLOW_ADDRESS,
  streamId: ZEROG_STREAM_ID,
});

// ── KeeperHub types ───────────────────────────────────────────────────────────
interface KeeperHubSubmitBody {
  chainId: number;
  to: string;
  data: string;
  value: string;
  gasLimit: string;
}

interface KeeperHubSubmitResponse {
  jobId: string;
  status: string;
}

interface KeeperHubStatusResponse {
  jobId: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  txHash?: string;
  error?: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Encode Uniswap V3 exactInputSingle calldata from the research quote.
function buildSwapCalldata(research: ResearchData, recipient: string): string {
  const iface = new ethers.Interface([
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  return iface.encodeFunctionData("exactInputSingle", [
    {
      tokenIn: research.tokenIn.address,
      tokenOut: research.tokenOut.address,
      fee: UNISWAP_POOL_FEE,
      recipient,
      deadline,
      amountIn: BigInt(research.amountIn),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    },
  ]);
}

// ── KeeperHub API calls ───────────────────────────────────────────────────────
const keeperHubHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  "Authorization": `Bearer ${KEEPERHUB_API_KEY}`,
});

async function submitTransaction(
  body: KeeperHubSubmitBody,
  taskId: string,
): Promise<KeeperHubSubmitResponse> {
  log(AGENT, "info", `Submitting tx to KeeperHub — to=${body.to} gasLimit=${body.gasLimit}`, taskId);
  const res = await axios.post<KeeperHubSubmitResponse>(
    `${KEEPERHUB_API_URL}/v1/transactions`,
    body,
    { headers: keeperHubHeaders() },
  );
  return res.data;
}

async function fetchJobStatus(jobId: string): Promise<KeeperHubStatusResponse> {
  const res = await axios.get<KeeperHubStatusResponse>(
    `${KEEPERHUB_API_URL}/v1/transactions/${jobId}`,
    { headers: keeperHubHeaders() },
  );
  return res.data;
}

// Poll until confirmed/failed or max attempts exhausted.
async function pollUntilSettled(jobId: string, taskId: string): Promise<KeeperHubStatusResponse> {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const status = await fetchJobStatus(jobId);
    log(AGENT, "info", `Poll ${attempt}/${POLL_MAX_ATTEMPTS} jobId=${jobId} status=${status.status}`, taskId);
    if (status.status === "confirmed" || status.status === "failed") return status;
    if (attempt < POLL_MAX_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Transaction not confirmed after ${POLL_MAX_ATTEMPTS} attempts (jobId=${jobId})`);
}

// ── APPROVE handler ───────────────────────────────────────────────────────────
async function handleApprove(msg: AgentMessage): Promise<void> {
  const { taskId } = msg;
  const payload = msg.payload as {
    researchKey?: string;
    planKey?: string;
    critiqueKey?: string;
    confidence?: number;
  };

  const researchKey = payload?.researchKey ?? `research:${taskId}`;
  log(AGENT, "info", `Processing APPROVE — reading ${researchKey}`, taskId);

  // 1. Load research data to get token/amount info for swap calldata.
  let research: ResearchData;
  try {
    const stored = await memory.get<ResearchData>(researchKey);
    if (stored === null) throw new Error(`key ${researchKey} not found in 0G Storage`);
    research = stored;
    log(AGENT, "info", `Research loaded — bestRoute="${research.bestRoute}"`, taskId);
  } catch (err) {
    log(AGENT, "error", `Failed to read research: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 2. Build swap calldata.
  const recipient = SWAP_RECIPIENT || EXECUTOR_WALLET_ADDRESS; // fallback for dev
  let calldata: string;
  try {
    calldata = buildSwapCalldata(research, recipient);
    log(AGENT, "info", "Swap calldata encoded", taskId);
  } catch (err) {
    log(AGENT, "error", `Calldata encoding failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // Notify planner that execution has started.
  if (PLANNER_PEER_ID) {
    try {
      await axl.sendMessage(PLANNER_PEER_ID,
        createMessage("executor", "planner", "PROGRESS", { phase: "executing" }, taskId));
    } catch { /* best-effort */ }
  }

  // 3. Submit to KeeperHub.
  const txBody: KeeperHubSubmitBody = {
    chainId: UNISWAP_CHAIN_ID,
    to: UNISWAP_ROUTER,
    data: calldata,
    value: "0",
    // Add 20 % gas buffer on top of the Uniswap quote estimate.
    gasLimit: String(Math.ceil(Number(research.gasEstimate) * 1.2)),
  };

  let jobId: string;
  try {
    const submit = await submitTransaction(txBody, taskId);
    jobId = submit.jobId;
    log(AGENT, "info", `Transaction submitted — jobId=${jobId}`, taskId);
  } catch (err) {
    log(AGENT, "error", `KeeperHub submit failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 4. Poll for confirmation (3 s interval, 10 attempts max).
  let settled: KeeperHubStatusResponse;
  try {
    settled = await pollUntilSettled(jobId, taskId);
  } catch (err) {
    log(AGENT, "error", `Polling exhausted: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  if (settled.status === "failed") {
    const reason = settled.error ?? "unknown failure";
    log(AGENT, "error", `Transaction failed on-chain — jobId=${jobId} reason="${reason}"`, taskId);
    await notifyError(taskId, `on-chain failure: ${reason}`);
    return;
  }

  // 5. Confirmed — persist execution log to 0G Storage.
  const txHash = settled.txHash ?? "";
  log(AGENT, "info", `Transaction confirmed — txHash=${txHash}`, taskId);

  try {
    await memory.set(`execution:${taskId}`, {
      taskId,
      jobId,
      txHash,
      chainId: UNISWAP_CHAIN_ID,
      to: UNISWAP_ROUTER,
      status: "DONE",
      executedAt: Date.now(),
    });
    log(AGENT, "info", `Execution result written to 0G Storage at execution:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G Storage write failed (non-fatal): ${toErrMsg(err)}`, taskId);
  }

  try {
    await memory.appendLog({ event: "DONE", taskId, txHash, status: "DONE", ts: Date.now() });
  } catch (err) {
    log(AGENT, "warn", `appendLog failed (non-fatal): ${toErrMsg(err)}`, taskId);
  }

  // 6. Notify Planner — task complete.
  if (!PLANNER_PEER_ID) {
    log(AGENT, "warn", "PLANNER_PEER_ID not set — skipping AXL dispatch", taskId);
    return;
  }

  const doneMsg = createMessage("executor", "planner", "DONE", {
    txHash,
    jobId,
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
      ["KEEPERHUB_API_KEY", KEEPERHUB_API_KEY],
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
