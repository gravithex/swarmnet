import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AXLClient,
  MemoryStore,
  createLLMClient,
  LLM_MODEL,
  readWalletSnapshot,
  createMessage,
  log,
  toErrMsg,
  type AgentMessage,
  type AgentRole,
  type PlanStep,
  type WalletSnapshot,
} from "@swarmnet/shared";

const AGENT: AgentRole = "planner";

// ── env ───────────────────────────────────────────────────────────────────────
const AXL_NODE_URL = process.env.AXL_NODE_URL ?? "http://localhost:9002";
const RESEARCHER_PEER_ID = process.env.RESEARCHER_PEER_ID ?? "";
const PLANNER_PORT = Number(process.env.PLANNER_PORT ?? "3001");

const ZEROG_INDEXER_URL = process.env.ZEROG_INDEXER_URL ?? "";
const ZEROG_KV_URL = process.env.ZEROG_KV_URL ?? "";
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const ZEROG_PRIVATE_KEY = process.env.ZEROG_PRIVATE_KEY ?? "";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "";
const ZEROG_STREAM_ID = process.env.ZEROG_STREAM_ID ?? "";

// ── sentinel config ───────────────────────────────────────────────────────────
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? "";
// How often the sentinel polls the treasury (ms). Default: 5 min.
const SENTINEL_INTERVAL_MS = Number(process.env.SENTINEL_INTERVAL_MS ?? "300000");
// Inject a fake snapshot instead of reading chain — useful when testnet ETH is scarce.
const SENTINEL_DEMO_MODE = process.env.SENTINEL_DEMO_MODE === "true";

// Sepolia token addresses the sentinel tracks.
const WATCHED_TOKENS = [
  { symbol: "WETH", address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18 },
  { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
  { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
];

// ── task status (in-memory — drives GET /status/:taskId) ─────────────────────
type TaskPhase =
  | "planning" | "researching" | "critiquing" | "executing"
  | "done" | "rejected" | "error";

interface TaskStatus {
  taskId: string;
  goal: string;
  phase: TaskPhase;
  txHash?: string;
  reason?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const taskStatus = new Map<string, TaskStatus>();

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

// ── LLM goal planning ─────────────────────────────────────────────────────────
interface GoalContext {
  strategyType: string;
  tokenIn: string;
  tokenOut: string;
  amountDescription: string;
  riskTolerance: "low" | "medium" | "high";
  maxSlippagePct: number;
  rationale: string;
  steps: Array<{ phase: string; instruction: string }>;
}

async function planWithLLM(goal: string, taskId: string): Promise<GoalContext> {
  const llm = createLLMClient();
  const completion = await llm.chat.completions.create({
    model: LLM_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are the Planner agent of a DeFi treasury management swarm.
Your job is to parse a natural-language goal and produce a structured execution plan.

ALWAYS respond with valid JSON matching exactly this schema:
{
  "strategyType": "swap" | "yield" | "rebalance" | "other",
  "tokenIn": "symbol or address of input token",
  "tokenOut": "symbol or address of output token",
  "amountDescription": "human-readable amount (e.g. '1 ETH', '500 USDC')",
  "riskTolerance": "low" | "medium" | "high",
  "maxSlippagePct": <number between 0.1 and 5.0>,
  "rationale": "one-paragraph explanation of the strategy and why it makes sense",
  "steps": [
    { "phase": "RESEARCH", "instruction": "what the researcher should fetch" },
    { "phase": "CRITIQUE", "instruction": "what the critic should check" },
    { "phase": "EXECUTE", "instruction": "what the executor should do" }
  ]
}`,
      },
      {
        role: "user",
        content: `Parse this DeFi goal and produce a structured plan:\n"${goal}"`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  log(AGENT, "info", `LLM plan: ${raw}`, taskId);
  return JSON.parse(raw) as GoalContext;
}

function buildSteps(ctx: GoalContext): PlanStep[] {
  const instructions = Object.fromEntries(ctx.steps.map(s => [s.phase, s.instruction]));
  return [
    {
      id: randomUUID(),
      description: instructions["RESEARCH"] ?? `Fetch market data for ${ctx.tokenIn}→${ctx.tokenOut}`,
      assignedTo: "researcher",
      dependsOn: [],
      status: "pending",
    },
    {
      id: randomUUID(),
      description: instructions["CRITIQUE"] ?? `Validate findings — maxSlippage ${ctx.maxSlippagePct}%, riskTolerance ${ctx.riskTolerance}`,
      assignedTo: "critic",
      dependsOn: [],
      status: "pending",
    },
    {
      id: randomUUID(),
      description: instructions["EXECUTE"] ?? `Execute ${ctx.strategyType} for ${ctx.amountDescription}`,
      assignedTo: "executor",
      dependsOn: [],
      status: "pending",
    },
  ];
}

// ── goal handler ──────────────────────────────────────────────────────────────
async function handleGoal(goal: string): Promise<string> {
  const taskId = randomUUID();
  const now = Date.now();
  log(AGENT, "info", `Received goal: "${goal}"`, taskId);

  taskStatus.set(taskId, { taskId, goal, phase: "planning", createdAt: now, updatedAt: now });

  // LLM parses and enriches the goal into a structured context.
  let goalContext: GoalContext;
  try {
    goalContext = await planWithLLM(goal, taskId);
    log(AGENT, "info", `Strategy: ${goalContext.strategyType} ${goalContext.tokenIn}→${goalContext.tokenOut} risk=${goalContext.riskTolerance}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `LLM planning failed, falling back to defaults: ${toErrMsg(err)}`, taskId);
    goalContext = {
      strategyType: "swap",
      tokenIn: "ETH",
      tokenOut: "USDC",
      amountDescription: goal,
      riskTolerance: "medium",
      maxSlippagePct: 0.5,
      rationale: goal,
      steps: [],
    };
  }

  const steps = buildSteps(goalContext);
  const plan = {
    taskId,
    goal,
    goalContext,
    steps,
    createdAt: now,
    status: "pending" as const,
  };

  try {
    await memory.set(`plan:${taskId}`, plan);
    log(AGENT, "info", `Plan persisted to 0G Storage at plan:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G unavailable — plan not persisted: ${toErrMsg(err)}`, taskId);
  }

  if (!RESEARCHER_PEER_ID) {
    log(AGENT, "warn", "RESEARCHER_PEER_ID not set — skipping AXL dispatch", taskId);
    return taskId;
  }

  const msg = createMessage("planner", "researcher", "TASK", {
    goal,
    goalContext,
    steps,
    planKey: `plan:${taskId}`,
  }, taskId);

  try {
    await axl.sendMessage(RESEARCHER_PEER_ID, msg);
    log(AGENT, "info", `TASK dispatched to researcher via AXL (peer=${RESEARCHER_PEER_ID})`, taskId);
    taskStatus.set(taskId, { ...taskStatus.get(taskId)!, phase: "researching", updatedAt: Date.now() });
  } catch (err) {
    log(AGENT, "error", `AXL sendMessage failed: ${toErrMsg(err)}`, taskId);
    throw err;
  }

  return taskId;
}

// ── incoming message handler ──────────────────────────────────────────────────
async function handleMessage(msg: AgentMessage): Promise<void> {
  if (msg.to !== AGENT && msg.to !== "broadcast") return;

  log(AGENT, "info", `Received ${msg.type} from ${msg.from}`, msg.taskId);

  if (msg.type === "PROGRESS") {
    const phase = (msg.payload as { phase?: TaskPhase })?.phase;
    if (phase && taskStatus.has(msg.taskId)) {
      taskStatus.set(msg.taskId, { ...taskStatus.get(msg.taskId)!, phase, updatedAt: Date.now() });
    }
    return;
  }

  if (msg.type === "DONE") {
    const p = msg.payload as { txHash?: string };
    const existing = taskStatus.get(msg.taskId);
    taskStatus.set(msg.taskId, {
      ...(existing ?? { taskId: msg.taskId, goal: "", createdAt: Date.now() }),
      phase: "done",
      txHash: p?.txHash,
      updatedAt: Date.now(),
    });
    try {
      await memory.appendLog({
        event: "DONE",
        taskId: msg.taskId,
        payload: msg.payload,
        ts: Date.now(),
      });
    } catch (err) {
      log(AGENT, "warn", `appendLog(DONE) failed (non-fatal): ${toErrMsg(err)}`, msg.taskId);
    }
    log(AGENT, "info", "Task completed successfully", msg.taskId);
    return;
  }

  if (msg.type === "REJECT") {
    const p = msg.payload as { reason?: string; confidence?: number };
    const existing = taskStatus.get(msg.taskId);
    taskStatus.set(msg.taskId, {
      ...(existing ?? { taskId: msg.taskId, goal: "", createdAt: Date.now() }),
      phase: "rejected",
      reason: p?.reason,
      updatedAt: Date.now(),
    });
    try {
      await memory.appendLog({
        event: "REJECT",
        taskId: msg.taskId,
        payload: msg.payload,
        ts: Date.now(),
      });
    } catch (err) {
      log(AGENT, "warn", `appendLog(REJECT) failed (non-fatal): ${toErrMsg(err)}`, msg.taskId);
    }
    log(AGENT, "warn", `Task rejected by ${msg.from}: ${JSON.stringify(msg.payload)}`, msg.taskId);
    return;
  }

  if (msg.type === "ERROR") {
    const p = msg.payload as { detail?: string };
    const existing = taskStatus.get(msg.taskId);
    taskStatus.set(msg.taskId, {
      ...(existing ?? { taskId: msg.taskId, goal: "", createdAt: Date.now() }),
      phase: "error",
      error: p?.detail,
      updatedAt: Date.now(),
    });
    log(AGENT, "error", `ERROR from ${msg.from}: ${JSON.stringify(msg.payload)}`, msg.taskId);
    return;
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function startHttp(): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        // Include the most recently created taskId so the demo script can
        // detect autonomous sentinel tasks without a separate endpoint.
        const latestTaskId = [...taskStatus.keys()].at(-1) ?? null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", agent: AGENT, latestTaskId }));
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/status/")) {
        const taskId = req.url.slice("/status/".length);
        const s = taskStatus.get(taskId);
        if (!s) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "task not found" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(s));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/goal") {
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { goal?: unknown };

          if (typeof body.goal !== "string" || body.goal.trim() === "") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "goal must be a non-empty string" }));
            return;
          }

          const taskId = await handleGoal(body.goal.trim());
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ taskId }));
        } catch (err) {
          log(AGENT, "error", `POST /goal unhandled: ${toErrMsg(err)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
        return;
      }

      res.writeHead(404);
      res.end();
    })();
  });

  server.listen(PLANNER_PORT, () => {
    log(AGENT, "info", `HTTP server listening on port ${PLANNER_PORT}`);
  });
}

// ── sentinel ──────────────────────────────────────────────────────────────────
interface SentinelDecision {
  shouldAct: boolean;
  goal: string;
  rationale: string;
  urgency: "low" | "medium" | "high";
}

async function evaluateWithLLM(snapshot: WalletSnapshot): Promise<SentinelDecision> {
  const llm = createLLMClient();
  const completion = await llm.chat.completions.create({
    model: LLM_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are the autonomous treasury Planner of a DeFi swarm on Ethereum Sepolia testnet.
Your job is to maximise the treasury's yield. You should ALWAYS find something to do unless every balance is zero.

RULES — apply them in order, stop at the first match:

1. If USDC balance > 10: swap at least half of it to WETH to gain ETH exposure.
   Example goal: "Swap 75 USDC to WETH with max 0.5% slippage"

2. If UNI, LINK, or any non-WETH ERC-20 balance > 1: consolidate into WETH.
   Example goal: "Swap 10 UNI to WETH with max 0.5% slippage"

3. If ETH balance > 0.05: wrap and deploy into the best Uniswap v3 WETH/USDC pool.
   Example goal: "Swap 0.05 ETH to USDC via the best Uniswap v3 WETH/USDC pool"

4. ONLY skip (shouldAct=false) when every token balance AND ETH balance are below 0.001 ETH equivalent.

The goal string must be concrete and actionable — include the exact amount, token symbols, and max slippage.

ALWAYS respond with valid JSON:
{
  "shouldAct": true | false,
  "goal": "concrete goal string (empty only if shouldAct=false)",
  "rationale": "one sentence referencing the specific balance that triggered the action",
  "urgency": "low" | "medium" | "high"
}`,
      },
      {
        role: "user",
        content: `Current treasury snapshot:\n${JSON.stringify(snapshot, null, 2)}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<SentinelDecision>;
  return {
    shouldAct: parsed.shouldAct === true,
    goal: typeof parsed.goal === "string" ? parsed.goal : "",
    rationale: parsed.rationale ?? "",
    urgency: (["low", "medium", "high"] as const).includes(parsed.urgency as "low")
      ? (parsed.urgency as "low" | "medium" | "high")
      : "low",
  };
}

function hasActiveTask(): boolean {
  for (const s of taskStatus.values()) {
    if (!["done", "rejected", "error"].includes(s.phase)) return true;
  }
  return false;
}

async function sentinelTick(): Promise<void> {
  if (!TREASURY_ADDRESS) return;

  if (hasActiveTask()) {
    log(AGENT, "info", "Sentinel: skipping tick — task already in progress");
    return;
  }

  let snapshot: WalletSnapshot;
  if (SENTINEL_DEMO_MODE) {
    snapshot = {
      address: TREASURY_ADDRESS,
      ethBalanceEth: "0.15",
      tokens: [
        { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, balance: "150.00" },
        { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, balance: "10.00" },
      ],
      capturedAt: Date.now(),
    };
    log(AGENT, "info", "Sentinel: using demo snapshot (SENTINEL_DEMO_MODE=true)");
  } else {
    if (!ZEROG_RPC_URL) return;
    try {
      snapshot = await readWalletSnapshot(ZEROG_RPC_URL, TREASURY_ADDRESS, WATCHED_TOKENS);
    } catch (err) {
      log(AGENT, "warn", `Sentinel: wallet read failed — ${toErrMsg(err)}`);
      return;
    }
  }

  const tokenSummary = snapshot.tokens.map(t => `${t.symbol}=${t.balance}`).join(", ") || "none";
  log(AGENT, "info", `Sentinel: ETH=${snapshot.ethBalanceEth} tokens=[${tokenSummary}]`);

  let decision: SentinelDecision;
  try {
    decision = await evaluateWithLLM(snapshot);
    log(AGENT, "info", `Sentinel: shouldAct=${decision.shouldAct} urgency=${decision.urgency} rationale="${decision.rationale}"`);
  } catch (err) {
    log(AGENT, "warn", `Sentinel: LLM evaluation failed — ${toErrMsg(err)}`);
    return;
  }

  if (decision.shouldAct && decision.goal) {
    log(AGENT, "info", `Sentinel: autonomously triggering goal — "${decision.goal}"`);
    try {
      await handleGoal(decision.goal);
    } catch (err) {
      log(AGENT, "error", `Sentinel: handleGoal failed — ${toErrMsg(err)}`);
    }
  }
}

function startSentinel(): void {
  if (!TREASURY_ADDRESS) {
    log(AGENT, "info", "Sentinel: TREASURY_ADDRESS not set — sentinel disabled");
    return;
  }
  log(AGENT, "info", `Sentinel: monitoring ${TREASURY_ADDRESS} every ${SENTINEL_INTERVAL_MS / 1000}s`);
  // Run first tick immediately, then on interval.
  void sentinelTick();
  setInterval(() => void sentinelTick(), SENTINEL_INTERVAL_MS);
}

// ── startup ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Warn early about missing config rather than failing silently mid-operation.
  const missing = (
    [
      ["RESEARCHER_PEER_ID", RESEARCHER_PEER_ID],
      ["ZEROG_RPC_URL", ZEROG_RPC_URL],
      ["ZEROG_PRIVATE_KEY", ZEROG_PRIVATE_KEY],
      ["ZEROG_FLOW_ADDRESS", ZEROG_FLOW_ADDRESS],
      ["ZEROG_STREAM_ID", ZEROG_STREAM_ID],
    ] as [string, string][]
  ).filter(([, v]) => v === "");

  if (missing.length > 0) {
    log(AGENT, "warn", `Missing env vars: ${missing.map(([k]) => k).join(", ")}`);
  }

  // Connect to AXL — block startup until we have a peer ID.
  let peerId: string;
  try {
    peerId = await axl.getPeerId();
    log(AGENT, "info", `Connected to AXL — peer id: ${peerId}`);
  } catch (err) {
    log(AGENT, "error", `AXL connection failed: ${toErrMsg(err)}`);
    process.exit(1);
  }

  // Subscribe to incoming AXL messages.
  axl.onMessage(handleMessage);
  log(AGENT, "info", "Subscribed to AXL message stream");

  startHttp();
  startSentinel();

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
