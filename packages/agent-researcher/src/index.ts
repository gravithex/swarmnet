import { createServer } from "node:http";
import {
  AXLClient,
  MemoryStore,
  createLLMClient,
  LLM_MODEL,
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
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? "";

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

// ── Known Sepolia token registry ──────────────────────────────────────────────
const SEPOLIA_TOKENS: Record<string, { address: string; decimals: number }> = {
  WETH: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18 },
  USDC: { address: "0x6f14C02Fc1F78322cFd7d707aB90f18baD3B54f5", decimals: 6 },
  UNI: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
};

// ── LLM swap intent resolution ────────────────────────────────────────────────
interface SwapParams {
  tokenInSymbol: string;
  tokenInAddress: string;
  tokenInDecimals: number;
  tokenOutSymbol: string;
  tokenOutAddress: string;
  tokenOutDecimals: number;
  amountIn: string;      // base units (e.g. "75000000000000000000" for 75 UNI)
  amountInHuman: string; // human-readable (e.g. "75")
  rationale: string;
}

async function resolveSwapParams(goal: string, goalContext: unknown, taskId: string): Promise<SwapParams> {
  const llm = createLLMClient();

  const completion = await llm.chat.completions.create({
    model: LLM_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are the Researcher agent of a DeFi swarm on Ethereum Sepolia testnet.
Your job is to resolve a swap intent into exact on-chain parameters for the Uniswap API.

Available tokens on Sepolia:
${JSON.stringify(
          Object.entries(SEPOLIA_TOKENS).map(([symbol, info]) => ({ symbol, ...info })),
          null, 2
        )}

RULES:
- tokenIn/tokenOut must be chosen from the list above
- amountIn must be in base units: multiply the human amount by 10^decimals, floor to integer, no decimal point
  Example: 75 UNI (18 decimals) → "75000000000000000000"
  Example: 10 WETH (18 decimals) → "10000000000000000000"
- If goal says "half of X", compute floor(X / 2)
- ETH and WETH are the same address on Sepolia — use WETH
- Default fallback if unclear: 1 UNI → WETH

ALWAYS respond with valid JSON:
{
  "tokenInSymbol": "UNI",
  "tokenInAddress": "0x...",
  "tokenInDecimals": 6,
  "tokenOutSymbol": "WETH",
  "tokenOutAddress": "0x...",
  "tokenOutDecimals": 18,
  "amountIn": "75000000",
  "amountInHuman": "75",
  "rationale": "one sentence explaining the resolved parameters"
}`,
      },
      {
        role: "user",
        content: `Resolve the swap parameters for this goal:\n"${goal}"\n\nPlanner context: ${JSON.stringify(goalContext)}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  log(AGENT, "info", `LLM swap resolution: ${raw}`, taskId);
  const parsed = JSON.parse(raw) as Partial<SwapParams>;

  const fallbackIn = SEPOLIA_TOKENS["UNI"];
  const fallbackOut = SEPOLIA_TOKENS["WETH"];
  const resolvedIn = SEPOLIA_TOKENS[parsed.tokenInSymbol ?? ""] ?? fallbackIn;
  const resolvedOut = SEPOLIA_TOKENS[parsed.tokenOutSymbol ?? ""] ?? fallbackOut;

  return {
    tokenInSymbol: parsed.tokenInSymbol ?? "UNI",
    tokenInAddress: parsed.tokenInAddress ?? resolvedIn.address,
    tokenInDecimals: parsed.tokenInDecimals ?? resolvedIn.decimals,
    tokenOutSymbol: parsed.tokenOutSymbol ?? "WETH",
    tokenOutAddress: parsed.tokenOutAddress ?? resolvedOut.address,
    tokenOutDecimals: parsed.tokenOutDecimals ?? resolvedOut.decimals,
    amountIn: parsed.amountIn ?? "1000000000000000000",
    amountInHuman: parsed.amountInHuman ?? "1",
    rationale: parsed.rationale ?? "Default swap parameters",
  };
}

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
async function fetchResearch(goal: string, params: SwapParams, taskId: string): Promise<ResearchData> {
  log(AGENT, "info", `Fetching Uniswap quote ${params.tokenInSymbol}→${params.tokenOutSymbol} amount=${params.amountInHuman} on chainId=${UNISWAP_CHAIN_ID}`, taskId);

  const body = {
    tokenInChainId: UNISWAP_CHAIN_ID,
    tokenIn: params.tokenInAddress,
    tokenOutChainId: UNISWAP_CHAIN_ID,
    tokenOut: params.tokenOutAddress,
    swapper: TREASURY_ADDRESS,
    amount: params.amountIn,
    type: "EXACT_INPUT",
    routingPreference: "BEST_PRICE",
    slippageTolerance: 0.3,
    protocols: ["V4", "V3"],
  };

  const res = await fetch(UNISWAP_QUOTE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-universal-router-version": "2.0",
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
  const payload = msg.payload as { goal?: string; planKey?: string; goalContext?: unknown };
  const goal = payload?.goal ?? "optimize DeFi yield";

  log(AGENT, "info", `Processing TASK — goal: "${goal}"`, taskId);

  // Notify planner that research has started.
  if (PLANNER_PEER_ID) {
    try {
      await axl.sendMessage(PLANNER_PEER_ID,
        createMessage("researcher", "planner", "PROGRESS", { phase: "researching" }, taskId));
    } catch { /* best-effort */ }
  }

  // 1. LLM resolves the goal into exact swap parameters.
  let swapParams: SwapParams;
  try {
    swapParams = await resolveSwapParams(goal, payload?.goalContext, taskId);
    log(AGENT, "info", `Swap params resolved — ${swapParams.tokenInSymbol}→${swapParams.tokenOutSymbol} amount=${swapParams.amountInHuman} (${swapParams.amountIn} base units)`, taskId);
    log(AGENT, "info", `Resolution rationale: ${swapParams.rationale}`, taskId);
  } catch (err) {
    log(AGENT, "error", `LLM swap resolution failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, `LLM swap resolution failed: ${toErrMsg(err)}`);
    return;
  }

  // 2. Fetch market data from Uniswap using the resolved params.
  let research: ResearchData;
  try {
    research = await fetchResearch(goal, swapParams, taskId);
    log(AGENT, "info", `Quote fetched — amountOut=${research.amountOut} priceImpact=${research.priceImpact}%`, taskId);
  } catch (err) {
    log(AGENT, "error", `Uniswap fetch failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 3. Persist findings to 0G Storage.
  try {
    await memory.set(`research:${taskId}`, research);
    log(AGENT, "info", `Research written to 0G Storage at research:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G unavailable — research not persisted: ${toErrMsg(err)}`, taskId);
  }

  // 4. Notify Critic via AXL.
  if (!CRITIC_PEER_ID) {
    log(AGENT, "warn", "CRITIC_PEER_ID not set — skipping AXL dispatch", taskId);
    return;
  }

  const outMsg = createMessage("researcher", "critic", "RESEARCH_DONE", {
    researchKey: `research:${taskId}`,
    planKey: payload?.planKey,
    researchData: research,
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
