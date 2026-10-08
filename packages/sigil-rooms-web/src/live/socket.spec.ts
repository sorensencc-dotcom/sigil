import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSocket } from './socket';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  drop() { this.onclose?.(); }
}

function make(overrides: Partial<ConstructorParameters<typeof LiveSocket>[0]> = {}) {
  const onFrame = vi.fn();
  const onStatus = vi.fn();
  const onReconnect = vi.fn();
  const getTicket = vi.fn(async () => `t${FakeSocket.instances.length + 1}`);
  const socket = new LiveSocket({
    streamUrl: 'ws://stream.test', getTicket, onFrame, onStatus, onReconnect,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket, backoffMs: () => 100, ...overrides,
  });
  return { socket, onFrame, onStatus, onReconnect, getTicket };
}

describe('LiveSocket', () => {
  beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the stream with the ticket and reports live', async () => {
    const { socket, onStatus } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances[0]!.url).toBe('ws://stream.test/v1/stream?ticket=t1');
    FakeSocket.instances[0]!.open();
    expect(onStatus).toHaveBeenLastCalledWith('live');
  });

  it('forwards room.updated frames and ignores everything else', async () => {
    const { socket, onFrame } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.message({ type: 'delivery.receipt', message_id: 'm' });
    ws.message('not json');
    ws.message({ type: 'room.updated', room_id: 'room_1', room_seq: '4', changed: 'messages' });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ type: 'room.updated', room_id: 'room_1', room_seq: '4', changed: 'messages' });
  });

  it('reconnects with a new ticket after a drop and signals onReconnect', async () => {
    const { socket, onStatus, onReconnect, getTicket } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.drop();
    expect(onStatus).toHaveBeenLastCalledWith('off');
    await vi.advanceTimersByTimeAsync(150);
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances[1]!.url).toBe('ws://stream.test/v1/stream?ticket=t2');
    FakeSocket.instances[1]!.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('backs off and retries when the ticket request fails', async () => {
    const getTicket = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValue('t-ok');
    const { socket, onStatus } = make({ getTicket });
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith('off');
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeSocket.instances[0]!.url).toBe('ws://stream.test/v1/stream?ticket=t-ok');
  });

  it('stop closes the socket and cancels the retry', async () => {
    const { socket, getTicket } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.open();
    socket.stop();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    FakeSocket.instances[0]!.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(getTicket).toHaveBeenCalledTimes(1);
  });
});
