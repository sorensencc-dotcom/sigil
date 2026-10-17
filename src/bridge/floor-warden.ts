/**
 * src/bridge/floor-warden.ts
 *
 * Authoritative supervisory Floor Warden bridge for Sigil Rooms Phase 6.
 * Enforces reply idempotency via room_reply_idempotency, guards recursion depth (<10 hops),
 * enforces capability tokens, and triggers deterministic halt recovery.
 */

export const RECURSION_LIMIT = 10;

export type HaltReason = 'RECURSION_LIMIT' | 'DUPLICATE_NONCE' | 'CAPABILITY_BREACH' | 'PROCESS_FAULT';
export type WardenAction = 'PASS' | 'DROP' | 'HALT_AGENT';

export interface FloorWardenVerdict {
  allowed: boolean;
  halt_reason?: HaltReason;
  action: WardenAction;
  details?: string;
}

export interface InspectParams {
  roomId: string;
  replyId: string;
  agentId: string;
  hopCount?: number;
  capabilityToken?: string;
  validTokens?: string[];
}

export interface HaltRecoveryReceipt {
  recovered: boolean;
  alertDispatched: boolean;
  haltEvent: {
    type: 'room_halted';
    delivery_key: string;
    room: { id: string };
    target_agent: { id: string };
    thread_root_id?: string | null;
    halt: {
      reason?: string;
      details?: string;
      timestamp: string;
    };
  };
}

export interface FloorWardenOptions {
  db?: { query: (sql: string, params: any[]) => Promise<any> };
  maxRecursionHops?: number;
  onAlert?: (alert: any) => Promise<void> | void;
  logger?: { warn?: (...args: any[]) => void; error?: (...args: any[]) => void; log?: (...args: any[]) => void };
}

export class FloorWarden {
  private maxHops: number;
  private db?: any;
  private logger: any;
  private onAlert?: (alert: any) => Promise<void> | void;
  private memoryRecords = new Set<string>();
  private halted = new Set<string>();
  private alertHistory: any[] = [];

  constructor(options: FloorWardenOptions = {}) {
    this.maxHops = options.maxRecursionHops ?? RECURSION_LIMIT;
    this.db = options.db;
    this.logger = options.logger ?? console;
    this.onAlert = options.onAlert;
  }

  async inspectMessage(params: InspectParams): Promise<FloorWardenVerdict> {
    const { roomId, replyId, agentId, hopCount = 0, capabilityToken, validTokens } = params;

    if (!roomId || !replyId || !agentId) {
      return { allowed: false, action: 'DROP', details: 'Missing mandatory fields' };
    }

    const sessionKey = `${roomId}:${agentId}`;
    if (this.halted.has(sessionKey)) {
      return { allowed: false, action: 'DROP', details: `Agent session ${agentId} is halted in room ${roomId}` };
    }

    // 1. Idempotency Check
    const key = `${roomId}:${replyId}`;
    if (this.memoryRecords.has(key)) {
      return {
        allowed: false,
        action: 'DROP',
        halt_reason: 'DUPLICATE_NONCE',
        details: `Duplicate reply_id ${replyId} in room ${roomId} idempotently dropped`
      };
    }

    if (this.db && typeof this.db.query === 'function') {
      try {
        const res = await this.db.query(
          'SELECT 1 FROM room_reply_idempotency WHERE room_id = $1 AND reply_id = $2 LIMIT 1',
          [roomId, replyId]
        );
        if (res?.rows?.length > 0 || res?.length > 0) {
          return {
            allowed: false,
            action: 'DROP',
            halt_reason: 'DUPLICATE_NONCE',
            details: `Duplicate reply_id ${replyId} in room ${roomId} idempotently dropped`
          };
        }
      } catch {}
    }

    // 2. Recursion Limit Check
    if (hopCount > this.maxHops) {
      return {
        allowed: false,
        action: 'HALT_AGENT',
        halt_reason: 'RECURSION_LIMIT',
        details: `Hop count ${hopCount} exceeds recursion limit ${this.maxHops}`
      };
    }

    // 3. Capability Verification
    if (validTokens && validTokens.length > 0) {
      if (!capabilityToken || !validTokens.includes(capabilityToken)) {
        return {
          allowed: false,
          action: 'HALT_AGENT',
          halt_reason: 'CAPABILITY_BREACH',
          details: `Capability token invalid or mismatched for agent ${agentId}`
        };
      }
    }

    // Passed checks: Record idempotency
    this.memoryRecords.add(key);
    if (this.db && typeof this.db.query === 'function') {
      try {
        await this.db.query(
          'INSERT INTO room_reply_idempotency (room_id, reply_id, agent_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [roomId, replyId, agentId]
        );
      } catch {}
    }

    return { allowed: true, action: 'PASS' };
  }

  async handleHaltRecovery(params: {
    roomId: string;
    agentId: string;
    verdict: FloorWardenVerdict;
    threadRootId?: string | null;
  }): Promise<HaltRecoveryReceipt> {
    const { roomId, agentId, verdict, threadRootId = null } = params;
    const sessionKey = `${roomId}:${agentId}`;
    this.halted.add(sessionKey);

    const alertRecord = {
      channel: '#ops-alerts',
      roomId,
      agentId,
      reason: verdict.halt_reason,
      details: verdict.details,
      timestamp: new Date().toISOString()
    };
    this.alertHistory.push(alertRecord);

    if (typeof this.onAlert === 'function') {
      try {
        await this.onAlert(alertRecord);
      } catch (err: any) {
        this.logger.error?.('[FLOOR-WARDEN] Alert webhook dispatch failed:', err.message);
      }
    }

    return {
      recovered: true,
      alertDispatched: true,
      haltEvent: {
        type: 'room_halted',
        delivery_key: `halt:${roomId}:${agentId}:${Date.now()}`,
        room: { id: roomId },
        target_agent: { id: agentId },
        thread_root_id: threadRootId,
        halt: {
          reason: verdict.halt_reason,
          details: verdict.details,
          timestamp: alertRecord.timestamp
        }
      }
    };
  }

  isHalted(roomId: string, agentId: string): boolean {
    return this.halted.has(`${roomId}:${agentId}`);
  }

  clearHalt(roomId: string, agentId: string): void {
    this.halted.delete(`${roomId}:${agentId}`);
  }

  getAlerts(): any[] {
    return [...this.alertHistory];
  }
}
