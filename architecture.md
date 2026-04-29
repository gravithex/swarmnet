# SwarmNet — Architecture

## Design Principles

1. **No central coordinator** — agents discover each other via AXL peer discovery, not a registry
2. **No in-process shortcuts** — every inter-agent message goes through AXL, even if agents run on the same machine
3. **Data travels in payloads** — research data is passed inline in AXL messages, not re-fetched from storage at each hop
4. **0G Storage is the audit trail** — plans, critiques, chain-of-thought, and execution records are written to 0G for verifiability
5. **Execution is KeeperHub's job** — the Executor triggers a workflow webhook; it never calls Ethereum directly

## Message Flow

```
User / Sentinel
    │
    ▼
Planner
  LLM (0G Compute): parse goal → GoalContext
  writes: plan:{taskId} → 0G Storage
    │
    │  AXL TASK {goal, goalContext, steps}
    ▼
Researcher
  LLM (0G Compute): resolve intent → {tokenIn, tokenOut, amountIn, addresses}
  Uniswap API: fetch best route, price impact, gas estimate
  writes: research:{taskId} → 0G Storage
    │
    │  AXL RESEARCH_DONE {researchData inline}
    ▼
Critic
  LLM (0G Compute): analyze price impact, sandwich risk, liquidity, route quality
  writes: critique:{taskId} + chainOfThought → 0G Storage
    │
    ├── verdict APPROVE ──────────────────────────────┐
    │   AXL APPROVE {researchData inline}              │
    │                                                  ▼
    │                                             Executor
    │                                   POST KeeperHub webhook
    │                                   polls GET /executions/{id}/status
    │                                   writes: execution:{taskId} → 0G Storage
    │                                             │
    │                                   AXL DONE {executionId}
    │                                             │
    └── verdict REJECT ───────────────────────────┘
        AXL REJECT {reason, confidence}           │
             │                                    │
             └────────────────────────────────────┘
                                    ▼
                                 Planner
                         updates task phase
```

## State Machine (per task)

```
planning → researching → critiquing → executing → processing → done
                                           ↓
                                         error
                                           ↓
                                      (planner notified)
```

## Agent Intelligence Layer

| Agent | 0G Compute call | Output |
|---|---|---|
| Planner | Parse natural-language goal | `GoalContext` with `tokenIn`, `tokenOut`, `amountDescription`, `riskTolerance`, `maxSlippagePct`, `steps[]` |
| Researcher | Resolve swap intent to on-chain params | `SwapParams` with addresses, decimals, `amountIn` in base units |
| Critic | Safety analysis of Uniswap quote | `verdict` (APPROVE/REJECT), `confidence`, `risks[]`, `chainOfThought` |
| Executor | — (deterministic) | Triggers KeeperHub webhook, polls status |

## 0G Storage Layout

```
KV writes (via Indexer + Batcher → storage nodes):
  plan:{taskId}           = { goal, goalContext, steps[], createdAt }
  research:{taskId}       = { tokenIn, tokenOut, amountIn, amountOut, bestRoute, priceImpact, gasEstimate, fetchedAt }
  critique:{taskId}       = { confidence, verdict, reason, risks[], chainOfThought, scoredAt }
  execution:{taskId}      = { executionId, workflowId, tokenIn, tokenOut, amountIn, status, executedAt }

Append-only log (unique key per entry — no read-then-write):
  __log__:{ts}:{rand}     = { event, taskId, ... }
```

> **Note on reads**: 0G KV reads require a dedicated KV node (32 GB RAM). In the current deployment, data flows **inline in AXL payloads** — reads from 0G are not required during normal operation. 0G Storage is used write-only as a verifiable audit trail.

## AXL Peer IDs

Each agent has a dedicated AXL node with its own private key (unique peer ID). Peer IDs are fetched after `setup-axl.sh` and pasted into `.env`:

```bash
PLANNER_PEER_ID=<from curl http://localhost:8081/topology>
RESEARCHER_PEER_ID=<from curl http://localhost:8082/topology>
CRITIC_PEER_ID=<from curl http://localhost:8083/topology>
EXECUTOR_PEER_ID=<from curl http://localhost:8084/topology>
```

## KeeperHub Integration

The Executor does not build transaction calldata. It POSTs a swap intent to the KeeperHub workflow webhook and delegates execution:

```
POST /api/workflows/{workflowId}/webhook
  Body: { taskId, tokenIn, tokenOut, amountIn, fee, recipient, amountOutMinimum, sqrtPriceLimitX96 }
  Response: { executionId, status: "running" }

GET /api/workflows/executions/{executionId}/status
  Polled every 5s until: success | error | cancelled
  Response: { status, nodeStatuses[], progress: { percentage, completedSteps, ... } }
```

## Failure Handling

| Failure | Handled by | Strategy |
|---|---|---|
| AXL send fails | Each agent | `notifyError` to Planner, task phase → `error` |
| 0G Storage write fails | Each agent | Logged as warn, non-fatal — data still lives in AXL payloads |
| Uniswap API error | Researcher | `notifyError` to Planner |
| LLM returns bad JSON | Planner / Researcher / Critic | Fallback defaults or `notifyError` |
| KeeperHub webhook fails | Executor | `notifyError` to Planner |
| KeeperHub execution error/cancelled | Executor | `notifyError` to Planner |
| KeeperHub poll timeout (20 × 5s) | Executor | `notifyError` to Planner |
| Critic REJECT | Critic | `REJECT` message to Planner, task phase → `rejected` |
