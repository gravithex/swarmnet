import axios, { AxiosInstance } from "axios";
import { AgentMessage, toErrMsg } from "../types/index.js";

export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

export class AXLClient {
  private readonly http: AxiosInstance;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(baseURL = "http://localhost:9002") {
    this.http = axios.create({ baseURL, timeout: 10_000 });
  }

  async getPeerId(): Promise<string> {
    try {
      const { data } = await this.http.get<{ our_public_key: string }>("/topology");
      return data.our_public_key;
    } catch (err) {
      throw new Error(`AXL getPeerId failed: ${toErrMsg(err)}`);
    }
  }

  async sendMessage(peerId: string, payload: AgentMessage): Promise<void> {
    try {
      await this.http.post("/send", JSON.stringify(payload), {
        headers: {
          "X-Destination-Peer-Id": peerId,
          "Content-Type": "text/plain",
        },
      });
    } catch (err) {
      throw new Error(`AXL sendMessage failed: ${toErrMsg(err)}`);
    }
  }

  onMessage(handler: MessageHandler, pollIntervalMs = 300): void {
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
    }
    this.pollingInterval = setInterval(async () => {
      try {
        const { data, status } = await this.http.get<string>("/recv", {
          responseType: "text",
          validateStatus: (s) => s < 500,
        });
        if (status === 204 || !data || data.trim() === "") return;
        let msg: AgentMessage;
        try {
          msg = JSON.parse(data) as AgentMessage;
        } catch {
          console.log(JSON.stringify({ level: "warn", message: "AXL /recv non-JSON body ignored", body: data }));
          return;
        }
        await handler(msg);
      } catch {
        // transient poll errors are tolerated
      }
    }, pollIntervalMs);
  }

  stopPolling(): void {
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
}
