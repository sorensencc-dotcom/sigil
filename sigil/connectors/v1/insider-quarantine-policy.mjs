import crypto from 'node:crypto';
import { capabilityForOperation } from './capability-policy.mjs';

export const INSIDER_TRUST_LEVEL = Object.freeze({
  TRUSTED: 'TRUSTED',
  CONDITIONAL: 'CONDITIONAL',
  QUARANTINED: 'QUARANTINED',
  UNTRUSTED: 'UNTRUSTED'
});

export const DEFAULT_ALLOWED_QUARANTINE_CAPABILITIES = Object.freeze(new Set([
  'sigil.approval/request',
  'sigil.quarantine/appeal',
  'sigil.task/read_inbox'
]));

/**
 * Zero-Trust Insider Quarantine Policy Manager
 * Protects agent-to-agent room messaging and connector execution boundaries
 * against compromised, untrusted, or anomalous internal agents.
 */
export class InsiderQuarantineManager {
  constructor(options = {}) {
    this.quarantinedAgents = new Map();
    this.messageBuffer = new Map(); // quarantineRecordId -> record
    this.defaultAllowedCapabilities = options.allowedCapabilities
      ? new Set(options.allowedCapabilities)
      : new Set(DEFAULT_ALLOWED_QUARANTINE_CAPABILITIES);
  }

  /**
   * Place an agent into zero-trust insider quarantine
   */
  quarantineAgent(agentId, {
    reason = 'Suspicious insider activity or untrusted agent state detected',
    quarantinedBy = 'system_sentinel',
    expiresAt = null,
    allowedCapabilities = null
  } = {}) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a string');
    }

    const record = {
      agentId,
      trustLevel: INSIDER_TRUST_LEVEL.QUARANTINED,
      reason,
      quarantinedBy,
      quarantinedAt: new Date().toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      allowedCapabilities: allowedCapabilities
        ? new Set(allowedCapabilities)
        : new Set(this.defaultAllowedCapabilities)
    };

    this.quarantinedAgents.set(agentId, record);
    return record;
  }

  /**
   * Release an agent from quarantine back to trusted status
   */
  releaseAgent(agentId, { releasedBy = 'security_admin', reason = 'Quarantine resolved after audit' } = {}) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a string');
    }

    const existing = this.quarantinedAgents.get(agentId);
    if (!existing) {
      return { agentId, released: false, message: 'Agent was not in quarantine' };
    }

    this.quarantinedAgents.delete(agentId);
    return {
      agentId,
      released: true,
      releasedBy,
      reason,
      releasedAt: new Date().toISOString()
    };
  }

  /**
   * Check whether an agent is actively quarantined
   */
  isAgentQuarantined(agentId) {
    if (!agentId || typeof agentId !== 'string') return false;
    const record = this.quarantinedAgents.get(agentId);
    if (!record) return false;

    // Check expiration if configured
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      this.quarantinedAgents.delete(agentId);
      return false;
    }

    return true;
  }

  /**
   * Get active quarantine details for an agent
   */
  getQuarantineDetails(agentId) {
    if (!this.isAgentQuarantined(agentId)) return null;
    const record = this.quarantinedAgents.get(agentId);
    return {
      agentId: record.agentId,
      trustLevel: record.trustLevel,
      reason: record.reason,
      quarantinedBy: record.quarantinedBy,
      quarantinedAt: record.quarantinedAt,
      expiresAt: record.expiresAt,
      allowedCapabilities: Array.from(record.allowedCapabilities)
    };
  }

  /**
   * Assert that an agent is authorized to execute an operation.
   * Throws INSIDER_QUARANTINED if the agent is quarantined and operation is not explicitly permitted.
   */
  assertNotQuarantined(agentId, operation) {
    if (!this.isAgentQuarantined(agentId)) {
      return true;
    }

    const details = this.quarantinedAgents.get(agentId);
    const requiredCap = capabilityForOperation(operation) || operation;

    const isPermitted = details.allowedCapabilities.has(operation) ||
      details.allowedCapabilities.has(requiredCap) ||
      Array.from(details.allowedCapabilities).some(grant => grant.endsWith('/*') && requiredCap.startsWith(grant.slice(0, -1)));

    if (!isPermitted) {
      const err = new Error(`Agent '${agentId}' is under zero-trust insider quarantine: operation '${operation}' blocked (${details.reason})`);
      err.code = 'INSIDER_QUARANTINED';
      err.agentId = agentId;
      err.operation = operation;
      err.reason = details.reason;
      throw err;
    }

    return true;
  }

  /**
   * Evaluate and enforce zero-trust boundary on agent-to-agent room messaging
   */
  evaluateRoomMessage({
    senderId,
    recipientId = null,
    roomId = 'default-room',
    message = {},
    metadata = {}
  } = {}) {
    if (!senderId || typeof senderId !== 'string') {
      throw new Error('senderId is required and must be a string');
    }

    // 1. Quarantined Sender Check
    if (this.isAgentQuarantined(senderId)) {
      const quarantineRecordId = `qmsg-${crypto.randomUUID()}`;
      const buffered = {
        quarantineRecordId,
        senderId,
        recipientId,
        roomId,
        message,
        metadata,
        quarantinedAt: new Date().toISOString(),
        status: 'BUFFERED_IN_QUARANTINE',
        reason: this.quarantinedAgents.get(senderId).reason
      };

      this.messageBuffer.set(quarantineRecordId, buffered);

      return {
        allowed: false,
        quarantined: true,
        status: 'QUARANTINED_MESSAGE',
        quarantineRecordId,
        reason: `Sender agent '${senderId}' is under insider quarantine: message held in isolation buffer`,
        bufferedMessage: buffered
      };
    }

    // 2. Quarantined Recipient Check
    if (recipientId && this.isAgentQuarantined(recipientId)) {
      return {
        allowed: false,
        quarantined: true,
        status: 'QUARANTINED_RECIPIENT',
        reason: `Recipient agent '${recipientId}' is quarantined: peer message delivery restricted`
      };
    }

    // 3. Trusted Message Delivery
    return {
      allowed: true,
      quarantined: false,
      status: 'DELIVERED',
      senderId,
      recipientId,
      roomId,
      message
    };
  }

  /**
   * Retrieve quarantined messages held in isolation
   */
  getQuarantinedMessages({ roomId = null, senderId = null } = {}) {
    let list = Array.from(this.messageBuffer.values());
    if (roomId) list = list.filter(m => m.roomId === roomId);
    if (senderId) list = list.filter(m => m.senderId === senderId);
    return list;
  }

  /**
   * Release and approve a quarantined message from the buffer
   */
  approveQuarantinedMessage(quarantineRecordId, { approvedBy = 'security_reviewer' } = {}) {
    const item = this.messageBuffer.get(quarantineRecordId);
    if (!item) {
      throw Object.assign(new Error(`Quarantined message not found: ${quarantineRecordId}`), { code: 'NOT_FOUND' });
    }

    this.messageBuffer.delete(quarantineRecordId);
    return {
      approved: true,
      approvedBy,
      approvedAt: new Date().toISOString(),
      message: item.message,
      senderId: item.senderId,
      recipientId: item.recipientId,
      roomId: item.roomId
    };
  }

  /**
   * Discard/reject a quarantined message from the buffer
   */
  rejectQuarantinedMessage(quarantineRecordId, { rejectedBy = 'security_reviewer', reason = 'Malicious or unverified content' } = {}) {
    const item = this.messageBuffer.get(quarantineRecordId);
    if (!item) {
      throw Object.assign(new Error(`Quarantined message not found: ${quarantineRecordId}`), { code: 'NOT_FOUND' });
    }

    this.messageBuffer.delete(quarantineRecordId);
    return {
      rejected: true,
      rejectedBy,
      rejectedAt: new Date().toISOString(),
      reason,
      quarantineRecordId
    };
  }
}
