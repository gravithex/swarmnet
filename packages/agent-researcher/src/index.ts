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

const AGENT: AgentRole = "researcher";

// ── env ───────────────────────────────────────────────────────────────────────
const AXL_NODE_URL = process.env.AXL_NODE_URL ?? "http://localhost:9002";
const CRITIC_PEER_ID = process.env.CRITIC_PEER_ID ?? "";
const PLANNER_PEER_ID = process.env.PLANNER_PEER_ID ?? "";
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "3002");

const UNISWAP_API_KEY = process.env.UNISWAP_API_KEY ?? "";
const UNISWAP_CHAIN_ID = Number(process.env.UNISWAP_CHAIN_ID ?? "11155111");
const UNISWAP_QUOTE_URL = "https://trade-api.gateway.uniswap.org/v1/quote";
const EXECUTOR_WALLET_ADDRESS = process.env.EXECUTOR_WALLET_ADDRESS ?? "";

const ZEROG_INDEXER_URL = process.env.ZEROG_INDEXER_URL ?? "";
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const ZEROG_PRIVATE_KEY = process.env.ZEROG_PRIVATE_KEY ?? "";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "";
const ZEROG_STREAM_ID = process.env.ZEROG_STREAM_ID ?? "";

// Canonical Sepolia token addresses.
const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const WETH_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const UNI_SEPOLIA = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
// 1 USDC — 6 decimals.
const SWAP_AMOUNT = "1000000";

// ── clients ───────────────────────────────────────────────────────────────────
const axl = new AXLClient(AXL_NODE_URL);

const memory = new MemoryStore({
  indexerUrl: ZEROG_INDEXER_URL,
  blockchainRpc: ZEROG_RPC_URL,
  privateKey: ZEROG_PRIVATE_KEY,
  flowAddress: ZEROG_FLOW_ADDRESS,
  streamId: ZEROG_STREAM_ID,
});

// ── Uniswap types ─────────────────────────────────────────────────────────────
interface UniswapToken {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name?: string;
}

interface UniswapRouteHop {
  type: string;
  address: string;
  tokenIn?: UniswapToken;
  tokenOut?: UniswapToken;
  fee?: string;
  liquidity?: string;
  amountIn?: string;
  amountOut?: string;
  [key: string]: unknown;
}

interface UniswapQuoteSuccess {
  routing: string;
  quote: {
    chainId: number;
    swapType: string;
    input: { token: UniswapToken; amount: string };
    output: { token: UniswapToken; amount: string };
    priceImpact: string;
    gasUseEstimate: string;
    gasUseEstimateUSD?: string;
    route: UniswapRouteHop[][];
    routeString?: string;
    slippage?: number;
  };
}

interface UniswapQuoteError {
  errorCode: string;
  detail?: string;
  id?: string;
}

type UniswapQuoteResponse = UniswapQuoteSuccess | UniswapQuoteError;

function isQuoteError(r: UniswapQuoteResponse): r is UniswapQuoteError {
  return "errorCode" in r;
}

// ── Uniswap fetch ─────────────────────────────────────────────────────────────
async function fetchResearch(goal: string, taskId: string): Promise<ResearchData> {
  log(AGENT, "info", `Fetching Uniswap quote USDC→WETH on chainId=${UNISWAP_CHAIN_ID}`, taskId);

  const body = {
    tokenInChainId: UNISWAP_CHAIN_ID,
    tokenIn: UNI_SEPOLIA,
    tokenOutChainId: UNISWAP_CHAIN_ID,
    tokenOut: WETH_SEPOLIA,
    swapper: EXECUTOR_WALLET_ADDRESS,
    amount: SWAP_AMOUNT,
    type: "EXACT_INPUT",
    routingPreference: 'BEST_PRICE',
    slippageTolerance: 0.3,
    protocols: ['V4', 'V3']
  };

  const res = await fetch(UNISWAP_QUOTE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      'x-universal-router-version': '2.0',
      "x-api-key": UNISWAP_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.json() as UniswapQuoteResponse;

  if (!res.ok || isQuoteError(raw)) {
    const detail = isQuoteError(raw) ? raw.detail ?? raw.errorCode : `HTTP ${res.status}`;
    throw new Error(`Uniswap quote failed: ${detail}`);
  }

  const { quote } = raw;

  // Extract unique pool addresses from the nested route array.
  const pools = [
    ...new Set(
      quote.route
        .flat()
        .map((hop) => hop.address)
        .filter((addr): addr is string => typeof addr === "string" && addr.length > 0)
    ),
  ];

  const bestRoute = quote.routeString ?? quote.route
    .map((hops) => hops.map((h) => h.address).join(" → "))
    .join(" | ");

  return {
    goal,
    tokenIn: { symbol: quote.input.token.symbol, address: quote.input.token.address, chainId: quote.input.token.chainId },
    tokenOut: { symbol: quote.output.token.symbol, address: quote.output.token.address, chainId: quote.output.token.chainId },
    amountIn: quote.input.amount,
    amountOut: quote.output.amount,
    pools,
    bestRoute,
    priceImpact: quote.priceImpact,
    gasEstimate: quote.gasUseEstimate,
    gasEstimateUSD: quote.gasUseEstimateUSD,
    fetchedAt: Date.now(),
  };
}

// ── task handler ──────────────────────────────────────────────────────────────
async function handleTask(msg: AgentMessage): Promise<void> {
  const { taskId } = msg;
  const payload = msg.payload as { goal?: string; planKey?: string };
  const goal = payload?.goal ?? "optimize DeFi yield";

  log(AGENT, "info", `Processing TASK — goal: "${goal}"`, taskId);

  // 1. Fetch market data from Uniswap.
  let research: ResearchData;
  try {
    research = await fetchResearch(goal, taskId);
    log(AGENT, "info", `Quote fetched — amountOut=${research.amountOut} priceImpact=${research.priceImpact}%`, taskId);
  } catch (err) {
    log(AGENT, "error", `Uniswap fetch failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 2. Persist findings to 0G Storage.
  try {
    await memory.set(`research:${taskId}`, research);
    log(AGENT, "info", `Research written to 0G Storage at research:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G unavailable — research not persisted: ${toErrMsg(err)}`, taskId);
  }

  // 3. Notify Critic via AXL.
  if (!CRITIC_PEER_ID) {
    log(AGENT, "warn", "CRITIC_PEER_ID not set — skipping AXL dispatch", taskId);
    return;
  }

  const outMsg = createMessage("researcher", "critic", "RESEARCH_DONE", {
    researchKey: `research:${taskId}`,
    planKey: payload?.planKey,
    summary: {
      pools: research.pools,
      bestRoute: research.bestRoute,
      priceImpact: research.priceImpact,
      gasEstimate: research.gasEstimate,
    },
  }, taskId);

  try {
    await axl.sendMessage(CRITIC_PEER_ID, outMsg);
    log(AGENT, "info", `RESEARCH_DONE dispatched to critic (peer=${CRITIC_PEER_ID})`, taskId);
  } catch (err) {
    log(AGENT, "error", `AXL sendMessage failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
  }
}

// Send an ERROR message back to the Planner so it can react.
async function notifyError(taskId: string, detail: string): Promise<void> {
  if (!PLANNER_PEER_ID) return;
  try {
    const errMsg = createMessage("researcher", "planner", "ERROR", { detail }, taskId);
    await axl.sendMessage(PLANNER_PEER_ID, errMsg);
  } catch {
    // best-effort; don't mask the original error
  }
}

// ── incoming message router ───────────────────────────────────────────────────
async function handleMessage(msg: AgentMessage): Promise<void> {
  if (msg.to !== AGENT && msg.to !== "broadcast") return;

  log(AGENT, "info", `Received ${msg.type} from ${msg.from}`, msg.taskId);

  if (msg.type === "TASK") {
    await handleTask(msg);
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
      ["CRITIC_PEER_ID", CRITIC_PEER_ID],
      ["UNISWAP_API_KEY", UNISWAP_API_KEY],
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
