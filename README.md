# SwarmNet 🕸️

> A decentralized multi-agent swarm for autonomous DeFi treasury management.  
> Built for the **Open Agents Hackathon** — April 24 to May 3, 2026.

---

## What is SwarmNet?

SwarmNet is a swarm of 4 specialized AI agents that collaborate **peer-to-peer** — with no central coordinator — to analyze, validate, and execute DeFi strategies onchain.

Each agent has a single responsibility. They communicate exclusively via **Gensyn AXL** (encrypted P2P), share persistent memory via **0G Storage**, and execute transactions reliably via **KeeperHub** and the **Uniswap API**.

```
Goal: "Optimize yield on 1 ETH"

[Planner] ──AXL──→ [Researcher] ──AXL──→ [Critic] ──AXL──→ [Executor]
    ↑                    ↓                     ↓                  ↓
    └────────────────────────────────────────────────────────────┘
                         0G Storage (shared memory)
                                                         KeeperHub ↓
                                                      Uniswap swap ✅
```

---

## Agents

| Agent | Role |
|---|---|
| **Planner** | Receives high-level goals, decomposes into tasks, orchestrates the swarm |
| **Researcher** | Fetches onchain data (Uniswap pools, prices, gas) |
| **Critic** | Validates research, scores confidence, approves or rejects execution |
| **Executor** | Constructs Uniswap swaps, submits via KeeperHub with retry + gas optimization |

---

## Tech Stack

| Component | Technology |
|---|---|
| Agent communication | [Gensyn AXL](https://docs.gensyn.ai/tech/agent-exchange-layer) — P2P encrypted, no broker |
| Shared memory | [0G Storage](https://docs.0g.ai) — KV for state, Log for history |
| Onchain execution | [KeeperHub](https://docs.keeperhub.com) — retry, gas optimization, audit trail |
| DeFi | [Uniswap API](https://developers.uniswap.org) — swap construction |
| Language | TypeScript / Node.js 20 |
| Infra | Docker + docker-compose |
| Chain | Ethereum Sepolia + 0G testnet |

---

## Why This Architecture?

Most multi-agent systems fake P2P — agents call each other via shared functions or a central message broker. SwarmNet uses **AXL** so agents are genuinely isolated processes that discover and message each other across the mesh, exactly as they would in production.

**0G Storage** replaces a shared database: agents write and read state without a server in the middle. This means memory is persistent, verifiable, and decentralized.

**KeeperHub** solves the last-mile problem of agent execution: gas spikes, failed transactions, and MEV are handled automatically with full audit trails — critical for autonomous agents moving real value.

---

## Setup

### Prerequisites

- Node.js 20+
- Docker + docker-compose
- AXL binary ([install guide](https://github.com/gensyn-ai/axl))
- 0G testnet wallet (funded via [faucet](https://faucet.0g.ai))
- KeeperHub API key ([app.keeperhub.com](https://app.keeperhub.com))
- Uniswap API key ([developers.uniswap.org](https://developers.uniswap.org))

### Install

```bash
git clone https://github.com/YOUR_USERNAME/swarmnet
cd swarmnet
npm install
cp .env.example .env
# Fill in your keys in .env
```

### Run

```bash
# Start AXL nodes
./scripts/setup-axl.sh

# Start all agents
docker-compose up

# Trigger demo scenario
npm run demo --workspace=packages/agent-planner
```

---

## Demo

> 📹 [Watch the demo video]() *(under 3 mins)*  
> 🔗 [Live demo]()

### Scenario walkthrough

1. User sends goal to Planner: *"Find the best USDC→WETH swap under 0.3% slippage"*
2. Planner decomposes and stores plan on **0G Storage**, broadcasts `RESEARCH` task via **AXL**
3. Researcher fetches Uniswap v3 pool data, writes findings to **0G Storage**, notifies Critic via **AXL**
4. Critic reads research from **0G Storage**, scores confidence, sends `APPROVE` to Executor via **AXL**
5. Executor builds swap via **Uniswap API**, submits through **KeeperHub** (with retry logic)
6. Execution result logged to **0G Storage** — full audit trail onchain

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         User / CLI                              │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    agent-planner :3001                          │
│  - Receives goal                                                │
│  - Decomposes tasks                                             │
│  - AXL peer: axl-planner                                        │
└──────────────┬──────────────────────────────────────────────────┘
               │ AXL (encrypted P2P)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   agent-researcher :3002                        │
│  - Uniswap API calls                                            │
│  - Writes to 0G Storage KV                                      │
│  - AXL peer: axl-researcher                                     │
└──────────────┬──────────────────────────────────────────────────┘
               │ AXL
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     agent-critic :3003                          │
│  - Reads 0G Storage KV                                          │
│  - Confidence scoring                                           │
│  - Appends to 0G Storage Log                                    │
│  - AXL peer: axl-critic                                         │
└──────────────┬──────────────────────────────────────────────────┘
               │ AXL
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    agent-executor :3004                         │
│  - Uniswap swap construction                                    │
│  - KeeperHub execution (retry, gas, MEV protection)             │
│  - Appends to 0G Storage Log                                    │
│  - AXL peer: axl-executor                                       │
└─────────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
     ┌────────────────┐            ┌──────────────────┐
     │  0G Storage    │            │   KeeperHub      │
     │  (KV + Log)    │            │   Execution      │
     └────────────────┘            └──────────────────┘
```

---

## Protocol Features & SDKs Used

- **Gensyn AXL** — all inter-agent communication, peer discovery, encryption
- **0G Storage SDK** (`@0glabs/0g-ts-sdk`) — shared agent memory (KV + Log)
- **0G Compute** — LLM inference for Planner and Critic reasoning
- **KeeperHub API + MCP** — guaranteed onchain execution with retry logic
- **Uniswap API** — swap route construction and pool data

---

## Team

| Name | Role | Contact |
|---|---|---|
| [YOUR NAME] | Solo dev | Telegram: @xxx · X: @xxx |

---

## Contract Deployments

| Contract | Network | Address |
|---|---|---|
| *(coming soon)* | Sepolia | `0x...` |

---

## License

MIT
