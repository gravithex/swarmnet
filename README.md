# SwarmNet 🕸️

> A decentralized multi-agent swarm for autonomous DeFi treasury management.  
> Built for the **Open Agents Hackathon** — April 24 to May 3, 2026.

---

## What is SwarmNet?

SwarmNet is a swarm of 4 specialized AI agents that collaborate **peer-to-peer** — with no central coordinator — to analyze, validate, and execute DeFi strategies onchain.

Each agent has a distinct intelligence layer. They communicate exclusively via **Gensyn AXL** (encrypted P2P mesh), reason via **0G Compute** LLMs, persist memory via **0G Storage**, and execute transactions reliably via **KeeperHub** and the **Uniswap API**.

```
Treasury wallet balance changes
         │
         ▼
[Planner] ──── LLM parses goal, builds plan ────→ 0G Storage (plan:{taskId})
    │                                                  │ AXL payload
    └──AXL──→ [Researcher] ─── Uniswap quote ─────────┘
                   │                                   │ AXL payload + researchData
                   └──AXL──→ [Critic] ─── LLM reasons ┘
                                  │        └→ 0G Storage (critique:{taskId} + CoT)
                                  └──AXL──→ [Executor] ── KeeperHub ── swap ✅
```

The Planner also runs a **sentinel loop**: it monitors the treasury wallet on-chain and autonomously dispatches tasks when it detects an opportunity — no human input required.

---

## Agents

| Agent | Intelligence | Role |
|---|---|---|
| **Planner** | LLM via 0G Compute | Monitors treasury, parses goals, produces structured execution plans |
| **Researcher** | Deterministic | Fetches Uniswap pool data, prices, gas estimates |
| **Critic** | LLM via 0G Compute | Reasons over research data — price impact, sandwich risk, route quality — stores chain-of-thought in 0G |
| **Executor** | Deterministic | Constructs Uniswap swaps, submits via KeeperHub with retry + gas optimization |

---

## Tech Stack

| Component | Technology |
|---|---|
| Agent communication | [Gensyn AXL](https://docs.gensyn.ai/tech/agent-exchange-layer) — P2P encrypted, no broker |
| AI inference | [0G Compute](https://docs.0g.ai/developer-hub/building-on-0g/compute) — LLM reasoning for Planner + Critic |
| Shared memory | [0G Storage](https://docs.0g.ai) — audit trail, plans, critique chain-of-thought |
| Onchain execution | [KeeperHub](https://docs.keeperhub.com) — retry, gas optimization, audit trail |
| DeFi | [Uniswap API](https://developers.uniswap.org) — swap construction and pool data |
| Language | TypeScript / Node.js 20 |
| Infra | Docker + docker-compose |
| Chain | Ethereum Sepolia + 0G testnet |

---

## Why This Architecture?

Most multi-agent systems fake P2P — agents call each other via shared functions or a central message broker. SwarmNet uses **AXL** so agents are genuinely isolated processes that discover and message each other across the mesh.

Research data travels **inside AXL message payloads** rather than being re-fetched from storage at each hop. This is both faster and resilient to storage node availability — while 0G Storage is still used for durable archival (plans, critiques, chain-of-thought logs).

The **Critic** doesn't just check numbers. It uses an LLM to reason about sandwich attack risk, liquidity depth, and route quality, and writes its full chain-of-thought to 0G Storage — giving judges and auditors a verifiable record of *why* each trade was approved or rejected.

---

## Setup

### Prerequisites

- Node.js 20+
- Docker + docker-compose
- AXL binary ([install guide](https://github.com/gensyn-ai/axl))
- 0G testnet wallet ([faucet](https://faucet.0g.ai)) — for storage writes
- 0G Compute key ([docs](https://docs.0g.ai/developer-hub/building-on-0g/compute/get-started)) — for LLM inference
- KeeperHub API key ([app.keeperhub.com](https://app.keeperhub.com))
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
# 0G Compute — primary LLM backend (Planner + Critic)
ZEROG_COMPUTE_ENDPOINT=https://api.0g.ai/v1
ZEROG_COMPUTE_KEY=your_key
LLM_MODEL=gpt-4o-mini          # model served by 0G Compute

# OpenAI — fallback for local dev (used when ZEROG_COMPUTE_ENDPOINT is unset)
OPENAI_API_KEY=sk-...

# Sentinel — autonomous treasury monitoring
TREASURY_ADDRESS=0x...          # wallet the Planner watches
SENTINEL_INTERVAL_MS=300000     # poll every 5 min (default)
SENTINEL_DEMO_MODE=false        # set true to skip chain read (no Sepolia ETH needed)
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
GOAL="Swap 0.05 ETH to USDC with max 0.5% slippage" ./scripts/demo.sh
```

What happens step by step:

1. **Planner** receives the goal → **0G Compute LLM** extracts `strategyType`, `tokenIn/Out`, `riskTolerance`, `maxSlippagePct`, and per-agent instructions → plan written to `plan:{taskId}` on 0G Storage, dispatched to Researcher via **AXL**
2. **Researcher** fetches Uniswap v3 pool data, best route, gas estimate → writes `research:{taskId}` to 0G Storage → sends full `researchData` to Critic inside the **AXL message payload**
3. **Critic** receives research inline (no storage re-fetch) → **0G Compute LLM** reasons about price impact, sandwich risk, route quality → writes `critique:{taskId}` with **chain-of-thought** to 0G Storage → sends `APPROVE` or `REJECT` + `researchData` to Executor via **AXL**
4. **Executor** receives `researchData` inline → builds Uniswap `exactInputSingle` calldata → submits via **KeeperHub** with retry + gas buffer → result logged to 0G Storage

### Sentinel mode (autonomous)

Set `TREASURY_ADDRESS` and `SENTINEL_DEMO_MODE=true` in `.env`, then:

```bash
./scripts/demo.sh --sentinel
```

The Planner polls the treasury every `SENTINEL_INTERVAL_MS`. When it detects a balance worth acting on, it calls **0G Compute** to reason about what to do, generates a goal autonomously, and fires the full swarm pipeline — no human input needed.

`SENTINEL_DEMO_MODE=true` injects a fake snapshot (0.15 ETH + 150 USDC + 10 UNI) so you can demo this without needing testnet ETH in the treasury.

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
│  ● Uniswap API: pool data, best route, gas estimate              │
│  ● Writes research:{taskId} to 0G Storage (archival)             │
│  ● AXL RESEARCH_DONE  {researchKey, researchData}  ← inline      │
│  ● AXL peer: axl-researcher                                      │
└───────────────────────────┬──────────────────────────────────────┘
                            │ AXL RESEARCH_DONE + full researchData
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                     agent-critic :3003                           │
│  ● Reads researchData from AXL payload (no KV fetch)             │
│  ● LLM (0G Compute): price impact, sandwich risk, route quality  │
│  ● Writes critique:{taskId} + chain-of-thought to 0G Storage     │
│  ● AXL APPROVE/REJECT  {critiqueKey, researchData}  ← inline     │
│  ● AXL peer: axl-critic                                          │
└───────────────────────────┬──────────────────────────────────────┘
                            │ AXL APPROVE + researchData
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                    agent-executor :3004                          │
│  ● Reads researchData from AXL payload (no KV fetch)             │
│  ● Builds Uniswap exactInputSingle calldata                      │
│  ● Submits via KeeperHub (retry, gas buffer, audit trail)        │
│  ● Writes execution:{taskId} to 0G Storage Log                   │
│  ● AXL peer: axl-executor                                        │
└──────────────────────────────────────────────────────────────────┘
          │ writes                               │ executes
          ▼                                      ▼
 ┌────────────────┐                    ┌──────────────────┐
 │  0G Storage    │                    │   KeeperHub      │
 │  plan + crit   │                    │   Sepolia swap   │
 │  + CoT logs    │                    └──────────────────┘
 └────────────────┘
          ▲
 ┌────────────────┐
 │  0G Compute    │
 │  LLM inference │
 │  Planner+Critic│
 └────────────────┘
```

---

## 0G Storage Convention

| Key | Writer | Content |
|---|---|---|
| `plan:{taskId}` | Planner | Goal context + LLM-generated steps |
| `research:{taskId}` | Researcher | Uniswap pool data, route, gas |
| `critique:{taskId}` | Critic | Confidence, verdict, risks, **chain-of-thought** |
| `execution:{taskId}` | Executor | KeeperHub job ID, tx hash, status |
| `__log__` | Critic + Executor | Append-only decision history |

---

## Protocol Features & SDKs Used

- **Gensyn AXL** — all inter-agent communication, peer discovery, encryption; research data travels inline in payloads
- **0G Compute** — LLM inference for Planner (goal parsing) and Critic (safety reasoning)
- **0G Storage SDK** (`@0gfoundation/0g-ts-sdk`) — durable audit trail: plans, critiques, chain-of-thought, execution results
- **KeeperHub API** — guaranteed onchain execution with retry, gas optimization, pre-flight checks
- **Uniswap API** — swap route construction and pool data

---

## Team

| Name | Role | Contact |
|---|---|---|
| [YOUR NAME] | Solo dev | Telegram: @xxx · X: @xxx |

---

## License

MIT
