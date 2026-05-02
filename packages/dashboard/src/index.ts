// SwarmNet terminal dashboard — polls agent HTTP endpoints, renders live ANSI view.
// Zero external dependencies; requires Node 20+ (native fetch).

// ── ANSI ──────────────────────────────────────────────────────────────────────
const E = "\x1b";
const R = `${E}[0m`;
const BOLD = `${E}[1m`;
const DIM = `${E}[2m`;
const GREEN = `${E}[32m`;
const RED = `${E}[31m`;
const YELLOW = `${E}[33m`;
const CYAN = `${E}[36m`;

// ── Config ────────────────────────────────────────────────────────────────────
const PLANNER_URL    = process.env.PLANNER_URL    ?? "http://localhost:3001";
const RESEARCHER_URL = process.env.RESEARCHER_URL ?? "http://localhost:3002";
const CRITIC_URL     = process.env.CRITIC_URL     ?? "http://localhost:3003";
const EXECUTOR_URL   = process.env.EXECUTOR_URL   ?? "http://localhost:3004";
const AXL_PLANNER    = process.env.AXL_PLANNER    ?? "http://localhost:8081";
const AXL_RESEARCHER = process.env.AXL_RESEARCHER ?? "http://localhost:8082";
const AXL_CRITIC     = process.env.AXL_CRITIC     ?? "http://localhost:8083";
const AXL_EXECUTOR   = process.env.AXL_EXECUTOR   ?? "http://localhost:8084";
const REFRESH_MS     = Number(process.env.REFRESH_MS ?? "2000");

// ── Types ─────────────────────────────────────────────────────────────────────
type ConnStatus = "up" | "down" | "pending";

type TaskPhase =
  | "planning" | "researching" | "critiquing" | "executing"
  | "done" | "rejected" | "error";

interface TaskStatus {
  taskId: string;
  goal: string;
  phase: TaskPhase;
  executionId?: string;
  reason?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  walletSummary?: string;
  sentinelNote?: string;
  quote?: string;
  critique?: string;
}

interface AgentEntry {
  label: string;
  agentUrl: string;
  axlUrl: string;
  agentStatus: ConnStatus;
  axlStatus: ConnStatus;
}

interface EventEntry {
  ts: string;   // HH:MM:SS
  type: string; // already ANSI-colored, padded to 13 visible chars
  detail: string;
}

interface State {
  agents: AgentEntry[];
  task: TaskStatus | null;
  taskId: string | null;
  lastPoll: Date;
  totalTasks: number;
  eventLog: EventEntry[];
  prevPhase: TaskPhase | null;
  prevAgentStatuses: Record<string, ConnStatus>;
}

const LOG_MAX = 8;

const state: State = {
  agents: [
    { label: "PLANNER",    agentUrl: PLANNER_URL,    axlUrl: AXL_PLANNER,    agentStatus: "pending", axlStatus: "pending" },
    { label: "RESEARCHER", agentUrl: RESEARCHER_URL, axlUrl: AXL_RESEARCHER, agentStatus: "pending", axlStatus: "pending" },
    { label: "CRITIC",     agentUrl: CRITIC_URL,     axlUrl: AXL_CRITIC,     agentStatus: "pending", axlStatus: "pending" },
    { label: "EXECUTOR",   agentUrl: EXECUTOR_URL,   axlUrl: AXL_EXECUTOR,   agentStatus: "pending", axlStatus: "pending" },
  ],
  task: null,
  taskId: null,
  lastPoll: new Date(),
  totalTasks: 0,
  eventLog: [],
  prevPhase: null,
  prevAgentStatuses: {},
};

function pushEvent(type: string, detail: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  state.eventLog.push({ ts, type, detail });
  if (state.eventLog.length > LOG_MAX) state.eventLog.shift();
}

// ── Fetching ──────────────────────────────────────────────────────────────────
async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1800) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function buildPhaseEvent(phase: TaskPhase, task: TaskStatus): { type: string; detail: string } | null {
  switch (phase) {
    case "researching":
      return { type: `${GREEN}→ research${R}`, detail: "researcher fetching Uniswap quote" };
    case "critiquing":
      return { type: `${GREEN}→ critique${R}`, detail: task.quote ?? "critic received RESEARCH_DONE via AXL" };
    case "executing":
      return { type: `${YELLOW}→ execute${R}`, detail: task.critique ?? "critic APPROVED (confidence > 0.8) via AXL" };
    case "done":
      return { type: `${GREEN}✓ done${R}`, detail: task.executionId ? `exec: ${task.executionId.slice(0, 24)}…` : "KeeperHub transaction submitted" };
    case "rejected":
      return { type: `${RED}✗ rejected${R}`, detail: task.critique ?? task.reason ?? "critic confidence < 0.8 — task rejected" };
    case "error":
      return { type: `${RED}✗ error${R}`, detail: task.error ?? "pipeline error — check agent logs" };
    default:
      return null;
  }
}

async function poll(): Promise<void> {
  // Snapshot previous agent statuses before updating.
  const prevStatuses: Record<string, ConnStatus> = {};
  for (const a of state.agents) prevStatuses[a.label] = a.agentStatus;

  // Check all agents and AXL nodes in parallel.
  const checks = await Promise.all(
    state.agents.flatMap((a) => [probe(`${a.agentUrl}/health`), probe(`${a.axlUrl}/topology`)])
  );

  state.agents.forEach((a, i) => {
    const next: ConnStatus = checks[i * 2] ? "up" : "down";
    // Emit event when an agent transitions between up and down (ignore initial "pending").
    if (prevStatuses[a.label] !== "pending" && prevStatuses[a.label] !== next) {
      if (next === "up") {
        pushEvent(`${GREEN}● online${R}`, `${a.label.toLowerCase()} agent connected`);
      } else {
        pushEvent(`${RED}✗ offline${R}`, `${a.label.toLowerCase()} agent unreachable`);
      }
    }
    a.agentStatus = next;
    a.axlStatus   = checks[i * 2 + 1] ? "up" : "down";
  });

  // Fetch latest task from planner.
  if (state.agents[0]!.agentStatus === "up") {
    const health = await fetchJson<{ latestTaskId?: string | null }>(`${PLANNER_URL}/health`);
    const latestId = health?.latestTaskId ?? null;

    if (latestId && latestId !== state.taskId) {
      state.taskId = latestId;
      state.totalTasks += 1;
      state.prevPhase = null;
      // Fetch task immediately so we can enrich the "new task" event with wallet data.
      const newTask = await fetchJson<TaskStatus>(`${PLANNER_URL}/status/${latestId}`);
      const walletDetail = newTask?.walletSummary
        ? `${latestId.slice(0, 8)}…  ${newTask.walletSummary}`
        : `${latestId.slice(0, 8)}…  sentinel triggered`;
      pushEvent(`${CYAN}new task${R}`, walletDetail);
      if (newTask?.sentinelNote) {
        pushEvent(`${DIM}sentinel${R}`, newTask.sentinelNote);
      }
      if (newTask) {
        state.task = newTask;
        state.prevPhase = "planning";
      }
    } else if (state.taskId) {
      const task = await fetchJson<TaskStatus>(`${PLANNER_URL}/status/${state.taskId}`);
      if (task) {
        if (task.phase !== state.prevPhase && state.prevPhase !== null) {
          const ev = buildPhaseEvent(task.phase, task);
          if (ev) pushEvent(ev.type, ev.detail);
        }
        state.prevPhase = task.phase;
        state.task = task;
      }
    }
  }

  state.lastPoll = new Date();
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const W = 110; // total box width including borders

/** Strip ANSI escape codes to get visible character count. */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad s to `width` visible characters (adding trailing spaces). */
function pad(s: string, width: number): string {
  const extra = Math.max(0, width - visLen(s));
  return s + " ".repeat(extra);
}

/** Truncate a plain string to at most `max` chars. */
function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function boxLine(content: string): string {
  return `│ ${pad(content, W - 4)} │`;
}

const DIVIDER = `├${"─".repeat(W - 2)}┤`;
const TOP     = `┌${"─".repeat(W - 2)}┐`;
const BOTTOM  = `└${"─".repeat(W - 2)}┘`;

function connDot(s: ConnStatus): string {
  if (s === "up")      return `${GREEN}●${R}`;
  if (s === "down")    return `${RED}✗${R}`;
  return `${DIM}?${R}`;
}

const PHASE_ORDER: TaskPhase[] = ["planning", "researching", "critiquing", "executing"];

const PHASE_LABEL: Record<TaskPhase, string> = {
  planning:    "PLANNING   ",
  researching: "RESEARCHING",
  critiquing:  "CRITIQUING ",
  executing:   "EXECUTING  ",
  done:        "DONE       ",
  rejected:    "REJECTED   ",
  error:       "ERROR      ",
};

const PHASE_DESC: Record<TaskPhase, string> = {
  planning:    "LLM decomposes goal → structured plan",
  researching: "Fetching Uniswap quote + token data",
  critiquing:  "Critic scores confidence (threshold 0.8)",
  executing:   "KeeperHub submits onchain transaction",
  done:        "",
  rejected:    "",
  error:       "",
};

function phaseRow(phase: TaskPhase, current: TaskPhase): string {
  const order = PHASE_ORDER;
  const pIdx = order.indexOf(phase);
  const cIdx = order.indexOf(current);
  const isDone = current === "done";

  let icon: string;
  if (isDone || (pIdx >= 0 && pIdx < cIdx)) {
    icon = `${GREEN}[✓]${R}`;
  } else if (pIdx === cIdx) {
    icon = `${YELLOW}[~]${R}`;
  } else {
    icon = `${DIM}[ ]${R}`;
  }

  const label = `${BOLD}${pad(PHASE_LABEL[phase], 13)}${R}`;
  const desc   = PHASE_DESC[phase];

  let status: string;
  if (isDone || (pIdx >= 0 && pIdx < cIdx)) {
    status = `${DIM}done${R}`;
  } else if (pIdx === cIdx) {
    status = `${YELLOW}in progress…${R}`;
  } else {
    status = `${DIM}waiting${R}`;
  }

  const left  = `  ${icon}  ${label}  ${pad(status, 14)}`;
  const right = `${DIM}${desc}${R}`;
  const inner = W - 4;
  const gap   = Math.max(1, inner - visLen(left) - visLen(right));
  return left + " ".repeat(gap) + right;
}

function render(): void {
  const now  = state.lastPoll.toLocaleTimeString("en-US", { hour12: false });
  const date = state.lastPoll.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });

  const lines: string[] = [TOP];

  // ── Header ──
  const header = `${BOLD}${CYAN}SwarmNet${R}  DeFi Swarm Monitor   ${DIM}${date} ${now}   Sepolia${R}`;
  lines.push(boxLine(header));
  lines.push(DIVIDER);

  // ── Agent grid ──
  const colW = Math.floor((W - 4) / 4); // ≈17 visible chars per column
  const agentHeader = state.agents.map((a) => pad(`${BOLD}${a.label}${R}`, colW)).join("");
  lines.push(boxLine(agentHeader));

  const agentStatus = state.agents.map((a) =>
    pad(`${connDot(a.agentStatus)} ${a.agentStatus === "up" ? "online" : a.agentStatus === "down" ? "offline" : "—"}`, colW)
  ).join("");
  lines.push(boxLine(agentStatus));

  const axlStatus = state.agents.map((a) => {
    const dot  = connDot(a.axlStatus);
    const text = a.axlStatus === "up" ? "AXL ok" : a.axlStatus === "down" ? "AXL down" : "AXL —";
    return pad(`${dot} ${text}`, colW);
  }).join("");
  lines.push(boxLine(axlStatus));

  lines.push(DIVIDER);

  // ── Task section ──
  if (!state.task && !state.taskId) {
    lines.push(boxLine(`${DIM}No active task — waiting for planner sentinel…${R}`));
  } else if (!state.task) {
    lines.push(boxLine(`${DIM}Loading task ${state.taskId?.slice(0, 8)}…${R}`));
  } else {
    const t = state.task;
    const shortId  = t.taskId.slice(0, 8);
    const goalDisp = trunc(t.goal, W - 14);

    lines.push(boxLine(`${BOLD}Task${R}  ${DIM}${shortId}…${R}   ${DIM}tasks seen: ${state.totalTasks}${R}`));
    lines.push(boxLine(`${DIM}Goal:${R}  ${goalDisp}`));
    lines.push(boxLine(""));

    for (const phase of PHASE_ORDER) {
      lines.push(boxLine(phaseRow(phase, t.phase)));
    }

    lines.push(boxLine(""));

    if (t.phase === "done") {
      const tx = t.executionId ? `  ${DIM}tx: ${trunc(t.executionId, 20)}…${R}` : "";
      lines.push(boxLine(`${GREEN}${BOLD}✓  TASK COMPLETE${R}${tx}`));
    } else if (t.phase === "rejected") {
      lines.push(boxLine(`${RED}${BOLD}✗  REJECTED${R}  ${DIM}${t.reason ?? "no reason given"}${R}`));
    } else if (t.phase === "error") {
      lines.push(boxLine(`${RED}${BOLD}✗  ERROR${R}  ${DIM}${trunc(t.error ?? "unknown", 45)}${R}`));
    } else {
      const phaseLabel = (PHASE_LABEL[t.phase] ?? t.phase.toUpperCase()).trim();
      lines.push(boxLine(`${YELLOW}◉  ${phaseLabel}${R}`));
    }
  }

  lines.push(DIVIDER);

  // ── Event log ──
  lines.push(boxLine(`${BOLD}Events${R}`));
  if (state.eventLog.length === 0) {
    lines.push(boxLine(`${DIM}  —  no events yet${R}`));
  } else {
    for (const ev of state.eventLog) {
      // Layout: HH:MM:SS  TYPE(13 visible)  DETAIL
      const time   = `${DIM}${ev.ts}${R}`;
      const type   = pad(ev.type, 13);
      const detail = trunc(ev.detail, W - 4 - 8 - 2 - 13 - 2);
      lines.push(boxLine(`  ${time}  ${type}  ${DIM}${detail}${R}`));
    }
    // Pad to LOG_MAX rows so the box height stays stable.
    for (let i = state.eventLog.length; i < LOG_MAX; i++) {
      lines.push(boxLine(""));
    }
  }

  lines.push(DIVIDER);
  lines.push(boxLine(`${DIM}Refreshing every ${REFRESH_MS / 1000}s   Ctrl+C to exit${R}`));
  lines.push(BOTTOM);

  // Write everything in a single call to avoid flicker.
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  process.stdout.write("\x1b[?25l"); // hide cursor

  process.on("SIGINT",  () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
  process.on("SIGTERM", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });

  await poll();
  render();

  setInterval(async () => {
    await poll();
    render();
  }, REFRESH_MS);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
