import type { RoomUpdatedFrame } from '../api/types';

export interface LiveSocketOptions {
  streamUrl: string;
  getTicket: () => Promise<string>;
  onFrame: (frame: RoomUpdatedFrame) => void;
  onStatus: (status: 'live' | 'off') => void;
  onReconnect: () => void;
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: (attempt: number) => number;
}

export class LiveSocket {
  private readonly options: LiveSocketOptions;
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private dropped = false;

  constructor(options: LiveSocketOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
  }

  private backoff(): number {
    return (this.options.backoffMs ?? ((n) => Math.min(30_000, 1000 * 2 ** n)))(this.attempt);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.options.onStatus('off');
    this.dropped = true;
    const delay = this.backoff();
    this.attempt += 1;
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let ticket: string;
    try {
      ticket = await this.options.getTicket();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const socket = new Impl(`${this.options.streamUrl}/v1/stream?ticket=${encodeURIComponent(ticket)}`);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.options.onStatus('live');
      if (this.dropped) {
        this.dropped = false;
        this.options.onReconnect();
      }
    };
    socket.onmessage = (event: MessageEvent) => {
      let frame: unknown;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if ((frame as { type?: string } | null)?.type === 'room.updated') this.options.onFrame(frame as RoomUpdatedFrame);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleRetry();
    };
  }
}
