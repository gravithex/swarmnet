# SwarmNet

> A decentralized multi-agent swarm for autonomous DeFi treasury management.  
> Built for the **Open Agents Hackathon** — April 24 to May 3, 2026.

---

## What is SwarmNet?

SwarmNet is a swarm of 4 specialized AI agents that collaborate **peer-to-peer** — with no central coordinator — to analyze, validate, and execute DeFi strategies onchain.

Three agents use **0G Compute** for LLM reasoning. They communicate exclusively via **Gensyn AXL** (encrypted P2P mesh), persist their audit trail via **0G Storage**, and execute trades by triggering a **KeeperHub** workflow via webhook.

```
Treasury wallet balance changes
         │
         ▼
[Planner]  ── LLM: parse goal → GoalContext ──────→ 0G Storage (plan:{taskId})
    │                                                    │ AXL TASK
    └──AXL──→ [Researcher] ── LLM: resolve params ──────┘
                                  └── Uniswap API quote
                   │                                    │ AXL RESEARCH_DONE + researchData
                   └──AXL──→ [Critic] ─── LLM: safety analysis
                                  │        └→ 0G Storage (critique:{taskId} + CoT)
                                  └──AXL──→ [Executor] ── KeeperHub webhook ── swap ✅
```

The Planner also runs a **sentinel loop**: it monitors the treasury wallet on-chain and autonomously dispatches tasks when it detects an opportunity — no human input required.

---

## Agents

| Agent | Intelligence | Role |
|---|---|---|
| **Planner** | LLM via 0G Compute | Monitors treasury, parses natural-language goals into structured `GoalContext` |
| **Researcher** | LLM via 0G Compute + Uniswap API | Resolves swap intent to exact on-chain params (tokens, amounts, addresses), fetches best route |
| **Critic** | LLM via 0G Compute | Reasons about price impact, sandwich risk, liquidity depth — stores chain-of-thought in 0G |
| **Executor** | Deterministic | Triggers KeeperHub workflow via webhook, polls execution status until confirmed |

---

## Tech Stack

| Component | Technology |
|---|---|
| Agent communication | [Gensyn AXL](https://docs.gensyn.ai/tech/agent-exchange-layer) — P2P encrypted, no broker |
| AI inference | [0G Compute](https://docs.0g.ai/developer-hub/building-on-0g/compute) — LLM for Planner, Researcher, Critic |
| Shared memory | [0G Storage](https://docs.0g.ai) — plans, research, critiques, chain-of-thought audit trail |
| Onchain execution | [KeeperHub](https://docs.keeperhub.com) — workflow webhook + execution status polling |
| DeFi | [Uniswap API](https://developers.uniswap.org) — swap routing and pool data |
| Language | TypeScript / Node.js 20 |
| Infra | Docker + docker-compose |
| Chain | Ethereum Sepolia + 0G testnet |

---

## Why This Architecture?

Most multi-agent systems fake P2P — agents call each other via shared functions or a central message broker. SwarmNet uses **AXL** so agents are genuinely isolated processes that discover and message each other across the mesh.

Research data travels **inside AXL message payloads** rather than being re-fetched from storage at each hop. This is faster and resilient to storage node availability, while 0G Storage is still used for the durable audit trail (plans, critiques, chain-of-thought logs).

The **Researcher** uses an LLM to interpret the planner's natural-language goal and resolve it to exact on-chain parameters — token addresses, decimals, base-unit amounts. This closes the loop: every agent from Planner to Researcher to Critic is reasoning with AI, not executing hardcoded logic.

The **Critic** writes its full chain-of-thought to 0G Storage — giving auditors a verifiable record of *why* each trade was approved or rejected, tied to an on-chain timestamp.

---

## Setup

### Prerequisites

- Node.js 20+
- Docker + docker-compose
- AXL binary ([install guide](https://github.com/gensyn-ai/axl))
- 0G testnet wallet ([faucet](https://faucet.0g.ai)) — for storage writes
- 0G Compute key ([docs](https://docs.0g.ai/developer-hub/building-on-0g/compute/get-started)) — for LLM inference
- KeeperHub account + workflow webhook ([app.keeperhub.com](https://app.keeperhub.com))
- Uniswap API key ([developers.uniswap.org](https://developers.uniswap.org))
- OpenAI API key — optional, fallback when 0G Compute is unavailable

### Install

```bash
git clone https://github.com/YOUR_USERNAME/swarmnet
cd swarmnet
npm install
cp .env.example .env
# Fill in your keys in .env
```

### Key environment variables

```bash
# 0G Compute — primary LLM backend (Planner + Researcher + Critic)
ZEROG_COMPUTE_ENDPOINT=https://api.0g.ai/v1
ZEROG_COMPUTE_KEY=your_key
LLM_MODEL=gpt-4o-mini          # model served by 0G Compute

# OpenAI — fallback for local dev (used when ZEROG_COMPUTE_ENDPOINT is unset)
OPENAI_API_KEY=sk-...

# KeeperHub — executor triggers this workflow via webhook
KEEPERHUB_WORKFLOW_ID=your_workflow_id
KEEPERHUB_USER_API_KEY=your_user_api_key   # for webhook auth
KEEPERHUB_ORG_API_KEY=your_org_api_key    # for execution status polling

# Uniswap — researcher fetches quotes, executor sends router address to KeeperHub
UNISWAP_API_KEY=your_key
UNISWAP_ROUTER=0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48   # Sepolia UniversalRouter

# Sentinel — autonomous treasury monitoring
TREASURY_ADDRESS=0x...          # wallet the Planner watches
SENTINEL_INTERVAL_MS=300000     # poll every 5 min (default)
SENTINEL_DEMO_MODE=false        # set true to skip chain read (no Sepolia ETH needed)

# 0G KV toggle — set true when a KV node (32 GB RAM) is running
# Agents read research data from 0G KV instead of AXL payload; Planner uses KV for crash recovery
USE_KV_STORAGE=false
```

### Run

```bash
# 1. Start AXL nodes (generates peer IDs, paste them into .env)
./scripts/setup-axl.sh

# 2. Start all agents
docker-compose up

# 3a. Manual demo — submit a goal
./scripts/demo.sh

# 3b. Sentinel demo — watch the Planner act autonomously
SENTINEL_DEMO_MODE=true ./scripts/demo.sh --sentinel
```

---

## Demo

> 📹 [Watch the demo video]() *(under 3 mins)*

### Manual mode

```bash
GOAL="Swap 75 USDC to WETH with max 0.5% slippage" ./scripts/demo.sh
```

What happens step by step:

1. **Planner** receives the goal → **0G Compute LLM** extracts `strategyType`, `tokenIn/Out`, `riskTolerance`, `maxSlippagePct`, and per-agent instructions → plan written to `plan:{taskId}` on 0G Storage, dispatched to Researcher via **AXL**
2. **Researcher** receives `{goal, goalContext}` → **0G Compute LLM** resolves intent to exact params (USDC address, 6 decimals, `amountIn=75000000`) → fetches Uniswap best route → writes `research:{taskId}` to 0G Storage → sends full `researchData` to Critic inside the **AXL message payload**
3. **Critic** receives research inline (no storage re-fetch) → **0G Compute LLM** reasons about price impact, sandwich risk, route quality → writes `critique:{taskId}` with **chain-of-thought** to 0G Storage → sends `APPROVE` or `REJECT` + `researchData` to Executor via **AXL**
4. **Executor** receives `researchData` → triggers **KeeperHub workflow** via webhook (`tokenIn`, `tokenOut`, `amountIn`, `fee`, `recipient`, `spender`) → KeeperHub calls `approve(spender, amountIn)` then executes the swap → Executor polls `GET /executions/{id}/status` until `success` → result logged to 0G Storage

### Sentinel mode (autonomous)

Set `TREASURY_ADDRESS` and `SENTINEL_DEMO_MODE=true` in `.env`, then:

```bash
./scripts/demo.sh --sentinel
```

The Planner polls the treasury every `SENTINEL_INTERVAL_MS`. When it detects a balance worth acting on, it calls **0G Compute** to reason about what to do, generates a concrete goal (e.g. `"Swap 75 USDC to WETH with max 0.5% slippage"`), and fires the full swarm pipeline — no human input needed.

`SENTINEL_DEMO_MODE=true` injects a fake snapshot (0.15 ETH + 150 USDC + 10 UNI) so you can demo this without testnet ETH in the treasury.

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│              User / CLI  (or Sentinel — autonomous)              │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTP POST /goal
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                     agent-planner :3001                          │
│  ● LLM (0G Compute): parse goal → GoalContext                    │
│  ● Sentinel: monitors treasury wallet on Sepolia                 │
│  ● Writes plan:{taskId} to 0G Storage                            │
│  ● AXL peer: axl-planner                                         │
└───────────────────────────┬──────────────────────────────────────┘
                            │ AXL TASK  {goal, goalContext, steps}
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                   agent-researcher :3002                         │
│  ● LLM (0G Compute): resolve intent → {tokenIn, tokenOut, amt}   │
│  ● Uniswap API: best route, price impact, gas estimate           │
│  ● Writes research:{taskId} to 0G Storage (archival)             │
│  ● AXL peer: axl-researcher                                      │
└───────────────────────────┬──────────────────────────────────────┘
                            │ AXL RESEARCH_DONE + full researchData (inline)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                     agent-critic :3003                           │
│  ● Reads researchData from AXL payload (USE_KV_STORAGE=false)     │
│  ● LLM (0G Compute): price impact, sandwich risk, route quality  │
│  ● Writes critique:{taskId} + chain-of-thought to 0G Storage     │
│  ● AXL peer: axl-critic                                          │
└───────────────────────────┬──────────────────────────────────────┘
                            │ AXL APPROVE + researchData (inline)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                    agent-executor :3004                          │
│  ● Reads researchData from AXL payload (USE_KV_STORAGE=false)     │
│  ● POST KeeperHub webhook → { executionId }                      │
│  ● KeeperHub: approve(spender, amountIn) then swap               │
│  ● Polls GET /executions/{executionId}/status until success      │
│  ● Writes execution:{taskId} to 0G Storage                       │
│  ● AXL peer: axl-executor                                        │
└──────────────────────────────────────────────────────────────────┘
          │ writes                               │ triggers
          ▼                                      ▼
 ┌────────────────┐                    ┌──────────────────┐
 │  0G Storage    │                    │   KeeperHub      │
 │  plan + crit   │                    │   workflow →     │
 │  + CoT logs    │                    │   Sepolia swap   │
 └────────────────┘                    └──────────────────┘
          ▲
 ┌────────────────┐
 │  0G Compute    │
 │  LLM inference │
 │  Planner +     │
 │  Researcher +  │
 │  Critic        │
 └────────────────┘
```

---

## 0G Storage Convention

| Key | Writer | Content |
|---|---|---|
| `plan:{taskId}` | Planner | GoalContext + LLM-generated steps |
| `research:{taskId}` | Researcher | Uniswap route, amounts, gas estimate |
| `critique:{taskId}` | Critic | Confidence, verdict, risks, **chain-of-thought** |
| `execution:{taskId}` | Executor | KeeperHub executionId, token pair, status |
| `swarm:current-task` | Planner | Current task phase — used for crash recovery on restart |
| `__log__:{ts}:{rand}` | Critic + Executor + Planner | Append-only decision history (one key per entry) |

---

## Protocol Features & SDKs Used

- **Gensyn AXL** — all inter-agent communication, peer discovery, encryption; research data travels inline in payloads
- **0G Compute** — LLM inference for Planner (goal parsing), Researcher (swap param resolution), and Critic (safety reasoning)
- **0G Storage SDK** (`@0gfoundation/0g-ts-sdk`) — durable audit trail: plans, critiques, chain-of-thought, execution records
- **KeeperHub** — onchain execution via workflow webhook; execution status tracked via polling API
- **Uniswap API** — swap routing, best price discovery, pool data

---

## Team

| Name | Role | Contact |
|---|---|---|
| [YOUR NAME] | Solo dev | Telegram: @xxx · X: @xxx |

---

## License

MIT
