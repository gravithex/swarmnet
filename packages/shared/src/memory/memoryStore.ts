import { KvClient, Indexer, Batcher, getFlowContract } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { toErrMsg } from "../types/index.js";

export interface MemoryStoreConfig {
  /** 0G Indexer URL — for writes */
  indexerUrl: string;
  /** 0G KV Node URL — for reads. Optional: get() throws if not provided. */
  kvClientUrl?: string;
  /** EVM-compatible RPC URL, e.g. https://evmrpc-testnet.0g.ai */
  blockchainRpc: string;
  /** Hex private key (0x-prefixed) — must hold gas funds */
  privateKey: string;
  /** 0G Flow contract address */
  flowAddress: string;
  /** KV stream ID (0x-prefixed 32-byte hex) shared by all agents */
  streamId: string;
}

// Reserved key for the append-only log.
const LOG_KEY = "__log__";

export class MemoryStore {
  private readonly indexerUrl: string;
  private readonly kvClientUrl: string | undefined;
  private readonly blockchainRpc: string;
  private readonly privateKey: string;
  private readonly flowAddress: string;
  private readonly streamId: string;
  // Wallet is created lazily on first write so a missing/placeholder
  // ZEROG_PRIVATE_KEY does not crash the process at startup.
  private _signer: ethers.Wallet | null = null;

  constructor(config: MemoryStoreConfig) {
    this.indexerUrl = config.indexerUrl;
    this.kvClientUrl = config.kvClientUrl;
    this.blockchainRpc = config.blockchainRpc;
    this.privateKey = config.privateKey;
    this.flowAddress = config.flowAddress;
    this.streamId = config.streamId;
  }

  private getSigner(): ethers.Wallet {
    if (!this._signer) {
      const provider = new ethers.JsonRpcProvider(this.blockchainRpc);
      this._signer = new ethers.Wallet(this.privateKey, provider);
    }
    return this._signer;
  }

  /**
   * Read a value from 0G KV storage.
   * Returns null when the key has never been written.
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    if (!this.kvClientUrl) throw new Error("MemoryStore.get: kvClientUrl not configured");
    try {
      const kvClient = new KvClient(this.kvClientUrl);
      const keyBytes = Uint8Array.from(Buffer.from(key, "utf-8"));
      const val = await kvClient.getValue(this.streamId, keyBytes);
      if (val === null) return null;
      const json = Buffer.from(val.data, "base64").toString("utf-8");
      return JSON.parse(json) as T;
    } catch (err) {
      throw new Error(
        `MemoryStore.get("${key}") failed: ${toErrMsg(err)}`
      );
    }
  }

  /**
   * Write a JSON-serialisable value to 0G KV storage.
   * Each call submits an on-chain transaction via the Batcher.
   */
  async set(key: string, value: unknown): Promise<void> {
    try {
      const indexer = new Indexer(this.indexerUrl);
      const [nodes, nodesErr] = await indexer.selectNodes(1);
      if (nodesErr !== null) throw nodesErr;

      // Cast required: ethers ESM vs CJS dual-package produces incompatible
      // Signer types at the TypeScript level; runtime behaviour is identical.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flow = getFlowContract(this.flowAddress, this.getSigner() as any);
      const batcher = new Batcher(1, nodes!, flow, this.blockchainRpc);

      const keyBytes = Uint8Array.from(Buffer.from(key, "utf-8"));
      const valueBytes = Uint8Array.from(
        Buffer.from(JSON.stringify(value), "utf-8")
      );
      batcher.streamDataBuilder.set(this.streamId, keyBytes, valueBytes);

      const [, execErr] = await batcher.exec();
      if (execErr !== null) throw execErr;
    } catch (err) {
      throw new Error(
        `MemoryStore.set("${key}") failed: ${toErrMsg(err)}`
      );
    }
  }

  /**
   * Append an entry to the shared log.
   * Each entry is written to a unique timestamped key — no KV read required.
   */
  async appendLog(entry: unknown): Promise<void> {
    const key = `${LOG_KEY}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await this.set(key, entry);
  }

  /**
   * Return all log entries. Requires kvClientUrl to be set.
   * Only usable when a KV node is available.
   */
  async getLog<T = unknown>(): Promise<T[]> {
    try {
      return (await this.get<T[]>(LOG_KEY)) ?? [];
    } catch (err) {
      throw new Error(`MemoryStore.getLog failed: ${toErrMsg(err)}`);
    }
  }
}
