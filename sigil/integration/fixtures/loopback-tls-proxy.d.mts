export const TLS_CERT: Buffer;
export function startLoopbackTlsProxy(options: { relayPort: number; staticPort: number; port?: number }): Promise<{
  port: number;
  origin: string;
  close(): Promise<void>;
}>;
