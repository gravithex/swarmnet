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

// ── LLM critique ──────────────────────────────────────────────────────────────
interface CritiqueResult {
  confidence: number;
  verdict: "APPROVE" | "REJECT";
  reasoning: string;
  risks: string[];
  chainOfThought: string;
}

async function critiqueWithLLM(research: ResearchData, taskId: string): Promise<CritiqueResult> {
  const llm = createLLMClient();
  const completion = await llm.chat.completions.create({
    model: LLM_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are the Critic agent of a DeFi treasury management swarm running on Ethereum Sepolia.
Your role is to protect the treasury by rigorously analyzing trade proposals before execution.

Evaluate the research data for:
1. Price impact risk (>1% is dangerous for large trades)
2. Liquidity depth (thin pools are vulnerable to sandwich attacks)
3. Gas cost proportionality (gas should be <1% of trade value)
4. Route quality (direct routes are safer than multi-hop)
5. Slippage vs. market conditions
6. Any red flags suggesting stale data or manipulation

ALWAYS respond with valid JSON:
{
  "confidence": <number 0.0–1.0>,
  "verdict": "APPROVE" | "REJECT",
  "reasoning": "one clear sentence explaining the verdict",
  "risks": ["risk1", "risk2", ...],
  "chainOfThought": "step-by-step analysis showing your reasoning process"
}

Approve (confidence >= 0.7) only if the trade is safe and the data is trustworthy.`,
      },
      {
        role: "user",
        content: `Analyze this DeFi trade proposal and decide whether to approve execution:\n${JSON.stringify(research, null, 2)}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  log(AGENT, "info", `LLM critique raw: ${raw}`, taskId);
  const parsed = JSON.parse(raw) as Partial<CritiqueResult>;

  return {
    confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
    verdict: parsed.verdict === "APPROVE" ? "APPROVE" : "REJECT",
    reasoning: parsed.reasoning ?? "No reasoning provided",
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    chainOfThought: parsed.chainOfThought ?? "",
  };
}

// ── RESEARCH_DONE handler ─────────────────────────────────────────────────────
async function handleResearchDone(msg: AgentMessage): Promise<void> {
  const { taskId } = msg;
  const payload = msg.payload as {
    researchKey?: string;
    planKey?: string;
    researchData?: ResearchData;
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

  // 1. Read research data — prefer inline payload, fall back to 0G KV.
  let research: ResearchData;
  try {
    if (payload?.researchData) {
      research = payload.researchData;
      log(AGENT, "info", `Research loaded from AXL payload — priceImpact=${research.priceImpact}% gasEstimate=${research.gasEstimate}`, taskId);
    } else {
      const stored = await memory.get<ResearchData>(researchKey);
      if (stored === null) throw new Error(`key ${researchKey} not found in 0G Storage`);
      research = stored;
      log(AGENT, "info", `Research loaded from 0G — priceImpact=${research.priceImpact}% gasEstimate=${research.gasEstimate}`, taskId);
    }
  } catch (err) {
    log(AGENT, "error", `Failed to read research: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, toErrMsg(err));
    return;
  }

  // 2. LLM critique — full reasoning over the research data.
  let critiqueResult: CritiqueResult;
  try {
    critiqueResult = await critiqueWithLLM(research, taskId);
  } catch (err) {
    log(AGENT, "error", `LLM critique failed: ${toErrMsg(err)}`, taskId);
    await notifyError(taskId, `LLM critique failed: ${toErrMsg(err)}`);
    return;
  }

  const { confidence, verdict, reasoning, risks, chainOfThought } = critiqueResult;
  log(AGENT, "info", `LLM critique — confidence=${confidence.toFixed(2)} verdict=${verdict} reasoning="${reasoning}"`, taskId);
  if (risks.length > 0) {
    log(AGENT, "info", `Identified risks: ${risks.join(", ")}`, taskId);
  }

  // 3. Persist critique + chain-of-thought to 0G Storage.
  const critique: CritiqueData = {
    taskId,
    confidence,
    verdict,
    reason: reasoning,
    scoredAt: Date.now(),
  };

  try {
    await memory.set(`critique:${taskId}`, {
      ...critique,
      risks,
      chainOfThought,
    });
    log(AGENT, "info", `Critique + CoT written to 0G Storage at critique:${taskId}`, taskId);
  } catch (err) {
    log(AGENT, "warn", `0G unavailable — critique not persisted: ${toErrMsg(err)}`, taskId);
  }

  // 4. Append full decision log (with CoT) to 0G shared log.
  try {
    await memory.appendLog({
      event: verdict,
      taskId,
      confidence,
      reasoning,
      risks,
      chainOfThought,
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
      researchData: research,
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
      reason: reasoning,
      risks,
    }, taskId);
    try {
      await axl.sendMessage(PLANNER_PEER_ID, rejectMsg);
      log(AGENT, "info", `REJECT dispatched to planner (peer=${PLANNER_PEER_ID}) reason="${reasoning}"`, taskId);
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

main().catch((err: unknown) => {
  console.error(JSON.stringify({ agent: AGENT, level: "error", message: String(err) }));
  process.exit(1);
});
