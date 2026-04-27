# SwarmNet — Architecture

## Design Principles

1. **No central coordinator** — agents discover each other via AXL peer discovery, not a registry
2. **No in-process shortcuts** — every inter-agent message goes through AXL, even if agents run on the same machine
3. **State lives in 0G** — no shared in-memory state; all reads/writes go through 0G Storage
4. **Execution is KeeperHub's job** — the Executor agent never calls Ethereum directly

## Message Flow

```
User Goal
    │
    ▼
Planner ──[TASK: research]──→ Researcher
    ↑                               │
    │                    [RESEARCH_DONE + taskId]
    │                               │
    │                               ▼
    │                           Critic
    │                    reads 0G Storage KV
    │                    scores confidence
    │                               │
    │              ┌────────────────┤
    │              │                │
    │        [APPROVE]           [REJECT]
    │              │                │
    │              ▼                ▼
    │          Executor          Planner (retry)
    │       builds swap
    │       KeeperHub exec
    │              │
    └──────[DONE: txHash]──────────┘
```

## State Machine (per task)

```
PENDING → RESEARCHING → VALIDATING → EXECUTING → DONE
                                         ↓
                                       FAILED → RETRYING
```

## 0G Storage Layout

```
KV store:
  plan:{taskId}         = { goal, tasks[], createdAt }
  research:{taskId}     = { pools[], bestRoute, gasEstimate, fetchedAt }
  critique:{taskId}     = { confidence, reasoning, verdict, scoredAt }
  swarm:state           = { activeTasks[], agentStatus{} }

Log store:
  execution             = append-only log of { taskId, txHash, status, timestamp }
  decisions             = append-only log of { taskId, from, verdict, reasoning }
```

## AXL Peer IDs

Each agent registers with a stable peer ID on startup, stored in its `.env`.  
Peer IDs are pre-shared via environment variables (no dynamic discovery needed for hackathon scope).

```
PLANNER_PEER_ID=axl-planner-001
RESEARCHER_PEER_ID=axl-researcher-001
CRITIC_PEER_ID=axl-critic-001
EXECUTOR_PEER_ID=axl-executor-001
```

## Failure Handling

| Failure | Handled by | Strategy |
|---|---|---|
| AXL message lost | Each agent | Timeout + re-request via AXL |
| 0G Storage write fail | Each agent | Retry 3x with exponential backoff |
| Uniswap API error | Researcher | Fallback to on-chain pool read |
| Transaction fail | KeeperHub | Automatic retry + gas bump |
| Low confidence | Critic | Sends REJECT to Planner, task retried with new params |
