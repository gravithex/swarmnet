import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AXLClient,
  MemoryStore,
  createMessage,
  log,
  toErrMsg,
  type AgentMessage,
  type AgentRole,
  type PlanStep,
} from "@swarmnet/shared";

const AGENT: AgentRole = "planner";

// ── env ───────────────────────────────────────────────────────────────────────
const AXL_NODE_URL = process.env.AXL_NODE_URL ?? "http://localhost:9002";
const RESEARCHER_PEER_ID = process.env.RESEARCHER_PEER_ID ?? "";
const PLANNER_PORT = Number(process.env.PLANNER_PORT ?? "3001");

const ZEROG_INDEXER_URL = process.env.ZEROG_INDEXER_URL ?? "";
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const ZEROG_PRIVATE_KEY = process.env.ZEROG_PRIVATE_KEY ?? "";
const ZEROG_FLOW_ADDRESS = process.env.ZEROG_FLOW_ADDRESS ?? "";
const ZEROG_STREAM_ID = process.env.ZEROG_STREAM_ID ?? "";

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
  blockchainRpc: ZEROG_RPC_URL,
  privateKey: ZEROG_PRIVATE_KEY,
  flowAddress: ZEROG_FLOW_ADDRESS,
  streamId: ZEROG_STREAM_ID,
});

// ── plan decomposition ────────────────────────────────────────────────────────
// Produces the four canonical phases: RESEARCH → VALIDATE → DECIDE → EXECUTE.
function decompose(goal: string): PlanStep[] {
  return [
    {
      id: randomUUID(),
      description: `Research DeFi market data and conditions for: ${goal}`,
      assignedTo: "researcher",
      dependsOn: [],
      status: "pending",
    },
    {
      id: randomUUID(),
      description: `Validate research findings and score confidence`,
      assignedTo: "critic",
      dependsOn: [],
      status: "pending",
    },
    {
      id: randomUUID(),
      description: `Execute approved transactions for: ${goal}`,
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

  const steps = decompose(goal);
  const plan = {
    taskId,
    goal,
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", agent: AGENT }));
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
