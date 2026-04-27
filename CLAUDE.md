# CLAUDE.md — SwarmNet Project Context

## What is SwarmNet?

SwarmNet is a multi-agent swarm for autonomous DeFi treasury management.
4 specialized agents communicate peer-to-peer via Gensyn AXL (encrypted, no central broker), share memory via 0G Storage, and execute onchain transactions via KeeperHub + Uniswap API.

Built for the Open Agents Hackathon (April 24 – May 3, 2026).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (tsx, Node.js 20+) |
| Monorepo | npm workspaces |
| Agent communication | Gensyn AXL (HTTP to localhost) |
| Shared memory | 0G Storage SDK (`@0glabs/0g-ts-sdk`) |
| Onchain execution | KeeperHub MCP / API |
| DeFi | Uniswap v3/v4 API |
| Infra | Docker + docker-compose |
| Chain | Ethereum Sepolia testnet / 0G testnet |

---

## Monorepo Structure

```
swarmnet/
├── CLAUDE.md                   ← you are here
├── README.md
├── FEEDBACK.md                 ← required for Uniswap + KeeperHub prizes
├── docker-compose.yml
├── package.json                ← workspace root
├── tsconfig.base.json
├── packages/
│   ├── shared/                 ← shared types, AXL client, 0G memory
│   │   └── src/
│   │       ├── axl/            ← AXLClient (HTTP wrapper)
│   │       ├── memory/         ← MemoryStore (0G Storage)
│   │       ├── types/          ← AgentMessage, SwarmState, etc.
│   │       └── index.ts
│   ├── agent-planner/          ← decomposes goals into tasks
│   │   └── src/index.ts
│   ├── agent-researcher/       ← fetches onchain/offchain data
│   │   └── src/index.ts
│   ├── agent-critic/           ← validates decisions, detects hallucinations
│   │   └── src/index.ts
│   └── agent-executor/         ← KeeperHub + Uniswap execution
│       └── src/index.ts
├── scripts/
│   ├── setup.sh                ← install AXL, fund wallets
│   ├── start-demo.sh           ← run full swarm scenario
│   └── check-health.sh
└── docs/
    └── architecture.md
```

---

## Agent Roles

### Planner (`agent-planner`)
- Receives a high-level goal (e.g. "optimize yield on 1 ETH")
- Decomposes it into tasks: `[RESEARCH, ANALYZE, DECIDE, EXECUTE]`
- Broadcasts tasks via AXL to appropriate agents
- Stores the plan in 0G Storage (KV)

### Researcher (`agent-researcher`)
- Listens for `RESEARCH` tasks via AXL
- Fetches Uniswap pool data, token prices, gas estimates
- Writes findings to 0G Storage (KV key: `research:{taskId}`)
- Notifies Critic via AXL when done

### Critic (`agent-critic`)
- Receives research results via AXL
- Validates data (sanity checks, hallucination detection)
- Scores confidence (0-1)
- If confidence > 0.8: sends `APPROVE` to Executor via AXL
- If confidence < 0.8: sends `REJECT` back to Planner
- Appends decision log to 0G Storage (Log)

### Executor (`agent-executor`)
- Listens for `APPROVE` messages via AXL
- Calls KeeperHub API to submit transaction with retry/gas logic
- Uses Uniswap API for swap construction
- Writes execution result to 0G Storage (Log)
- Notifies Planner: task complete

---

## Communication Protocol (AXL)

All inter-agent messages use this shape:

```typescript
interface AgentMessage {
  id: string;           // uuid
  from: AgentRole;      // 'planner' | 'researcher' | 'critic' | 'executor'
  to: AgentRole | 'broadcast';
  type: MessageType;    // 'TASK' | 'RESEARCH_DONE' | 'APPROVE' | 'REJECT' | 'DONE' | 'ERROR'
  payload: unknown;
  timestamp: number;
  taskId: string;       // links messages to the same goal
}
```

---

## 0G Storage Convention

| Key pattern | Layer | Owner | Content |
|---|---|---|---|
| `plan:{taskId}` | KV | Planner | Task decomposition |
| `research:{taskId}` | KV | Researcher | Market data, prices |
| `critique:{taskId}` | KV | Critic | Confidence score + reasoning |
| `execution:{taskId}` | Log | Executor | Transaction hash, status |
| `swarm:state` | KV | All | Current swarm status |

---

## Environment Variables

Each agent package uses a `.env` file. Never commit secrets.

```bash
# shared by all agents
AXL_NODE_URL=http://localhost:9002
ZEROG_RPC_URL=https://evmrpc-testnet.0g.ai
ZEROG_PRIVATE_KEY=0x...
ZEROG_FLOW_ADDRESS=0x...        # 0G Storage contract

# agent-executor only
KEEPERHUB_API_KEY=...
KEEPERHUB_API_URL=https://api.keeperhub.com
UNISWAP_API_KEY=...
UNISWAP_CHAIN_ID=11155111       # Sepolia

# LLM backend (via 0G Compute or fallback)
ZEROG_COMPUTE_ENDPOINT=https://...
OPENAI_API_KEY=...              # fallback for local dev
```

---

## Coding Conventions

- **No classes for agents** — use plain async functions + exported handlers
- **Error handling** — always wrap AXL calls and 0G Storage calls in try/catch with structured logging
- **Logging** — use `console.log(JSON.stringify({agent, level, message, taskId}))` for machine-readable logs
- **No shared mutable state in memory** — all state goes through 0G Storage or AXL messages
- **Types first** — define the interface in `shared/src/types/` before implementing
- **One file per concern** — `axlClient.ts`, `memoryStore.ts`, `uniswapClient.ts`, `keeperhubClient.ts`

---

## Running Locally

```bash
# 1. Start AXL nodes (one per agent)
./scripts/setup-axl.sh

# 2. Install dependencies
npm install

# 3. Start all agents
docker-compose up

# 4. Trigger a demo scenario
npm run demo --workspace=packages/agent-planner
```

---

## Prize Targets (do not break these integrations)

| Sponsor | Track | Key requirement |
|---|---|---|
| **0G** | Best Autonomous Agents/Swarms | Must use 0G Storage + 0G Compute |
| **Gensyn** | Best AXL Application | AXL must be used for ALL inter-agent comms, no in-process shortcuts |
| **KeeperHub** | Best Use / Best Integration | KeeperHub executes the final transaction, must show retry logic |
| **Uniswap** | Best API Integration | Swap must be constructed via Uniswap API, FEEDBACK.md required |

> ⚠️ Do not replace AXL with in-process function calls. The judges will check.
> ⚠️ Do not skip FEEDBACK.md for Uniswap and KeeperHub — it's required for prize eligibility.

---

## Key External Docs

- AXL: https://docs.gensyn.ai/tech/agent-exchange-layer
- AXL GitHub: https://github.com/gensyn-ai/axl
- 0G SDK: https://docs.0g.ai
- 0G Builder Hub: https://build.0g.ai
- KeeperHub MCP: https://docs.keeperhub.com/ai-tools
- KeeperHub API: https://docs.keeperhub.com/api
- Uniswap Dev: https://developers.uniswap.org
- Uniswap AI repo: https://github.com/Uniswap/uniswap-ai
