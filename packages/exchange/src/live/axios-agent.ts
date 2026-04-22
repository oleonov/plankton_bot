import https from "node:https";

export interface ClobAxiosAgentOptions {
  maxSockets: number;
  maxFreeSockets: number;
  idleTimeoutMs: number;
}

export function buildClobAxiosAgent(opts: ClobAxiosAgentOptions): https.Agent {
  return new https.Agent({
    keepAlive: true,
    maxSockets: opts.maxSockets,
    maxFreeSockets: opts.maxFreeSockets,
    timeout: opts.idleTimeoutMs,
    scheduling: "lifo",
  });
}
