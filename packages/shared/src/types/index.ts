import { randomUUID } from "crypto";

// ── trading config ────────────────────────────────────────────────────────────
export const MAX_SLIPPAGE = 0.5; // percent, e.g. 0.5 = 0.5%

export type AgentRole = "planner" | "researcher" | "critic" | "executor";

export type MessageType =
  | "TASK"
  | "RESEARCH_DONE"
  | "APPROVE"
  | "REJECT"
  | "DONE"
  | "ERROR"
  | "PROGRESS";

export interface AgentMessage {
  id: string;
  from: AgentRole;
  to: AgentRole | "broadcast";
  type: MessageType;
  payload: unknown;
  timestamp: number;
  taskId: string;
}

export interface Task {
  id: string;
  goal: string;
  status: "pending" | "in_progress" | "done" | "failed";
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanStep {
  id: string;
  description: string;
  assignedTo: AgentRole;
  dependsOn: string[];
  status: "pending" | "in_progress" | "done" | "skipped";
}

export interface ResearchResult {
  query: string;
  summary: string;
  sources: string[];
  confidence: number;
}

export interface CriticFeedback {
  targetStepId: string;
  approved: boolean;
  suggestions: string[];
  score: number;
}

export interface ResearchData {
  goal: string;
  tokenIn: { symbol: string; address: string; chainId: number };
  tokenOut: { symbol: string; address: string; chainId: number };
  amountIn: string;
  amountOut: string;
  pools: string[];
  bestRoute: string;
  priceImpact: string;
  gasEstimate: string;
  gasEstimateUSD?: string;
  fetchedAt: number;
}

export interface ExecutionReport {
  stepId: string;
  output: string;
  success: boolean;
  durationMs: number;
}

export interface SwarmState {
  activeTaskId: string | null;
  phase: "idle" | "planning" | "researching" | "critiquing" | "executing";
  updatedAt: number;
}

export function createTask(goal: string): Task {
  const now = new Date();
  return {
    id: randomUUID(),
    goal,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export function createMessage(
  from: AgentRole,
  to: AgentRole | "broadcast",
  type: MessageType,
  payload: unknown,
  taskId: string
): AgentMessage {
  return {
    id: randomUUID(),
    from,
    to,
    type,
    payload,
    timestamp: Date.now(),
    taskId,
  };
}

/** Safely extract a printable message from any thrown value. */
export function toErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function log(
  agent: AgentRole,
  level: "info" | "warn" | "error",
  message: string,
  taskId?: string
): void {
  console.log(JSON.stringify({ agent, level, message, taskId }));
}
