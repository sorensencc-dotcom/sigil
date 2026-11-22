import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

export const SCHEMAS = Object.freeze({
  task: {
    $id: 'sigil.task.request.v1',
    title: 'Sigil Task Request Envelope',
    type: 'object',
    required: ['protocol', 'message_type', 'id', 'timestamp', 'conversation_id', 'body'],
    properties: {
      protocol: { type: 'string', const: 'sigil.task/v1' },
      message_type: { type: 'string', const: 'task.request' },
      id: { type: 'string', pattern: '^env_[a-zA-Z0-9_-]+$' },
      timestamp: { type: 'string', format: 'date-time' },
      conversation_id: { type: 'string', minLength: 1 },
      sender: {
        type: 'object',
        required: ['endpoint_id', 'owner_id'],
        properties: {
          endpoint_id: { type: 'string' },
          owner_id: { type: 'string' },
        },
      },
      recipient: {
        type: 'object',
        required: ['endpoint_id', 'owner_id'],
        properties: {
          endpoint_id: { type: 'string' },
          owner_id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['task_id', 'instruction'],
        properties: {
          task_id: { type: 'string', minLength: 1 },
          instruction: { type: 'string', minLength: 1 },
          assignee: { type: 'string', minLength: 1 },
          success_criteria: { type: 'array', items: { type: 'string' } },
          dependencies: { type: 'array', items: { type: 'string' } },
          deadline: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  'task.result': {
    $id: 'sigil.task.result.v1',
    title: 'Sigil Task Result Envelope',
    type: 'object',
    required: ['protocol', 'message_type', 'id', 'timestamp', 'conversation_id', 'body'],
    properties: {
      protocol: { type: 'string', const: 'sigil.task/v1' },
      message_type: { type: 'string', const: 'task.result' },
      id: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      conversation_id: { type: 'string' },
      body: {
        type: 'object',
        required: ['task_id', 'status'],
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'failed', 'rejected'] },
          output: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
  },
  'room.message': {
    $id: 'sigil.room.message.v1',
    title: 'Sigil Room Message Envelope',
    type: 'object',
    required: ['protocol', 'message_type', 'id', 'timestamp', 'conversation_id', 'body'],
    properties: {
      protocol: { type: 'string', const: 'sigil.room/v1' },
      message_type: { type: 'string', const: 'room.message' },
      id: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      conversation_id: { type: 'string' },
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 20000 },
          thread_root_id: { type: 'string' },
          mentions: { type: 'array', maxItems: 50, items: { type: 'string' } },
        },
      },
    },
  },
  contract: {
    $id: 'sigil.torquequery.contract.v1',
    title: 'TorqueQuery Agent Dispatch Contract',
    type: 'object',
    required: ['contract_version', 'contract_id', 'issuer', 'subject', 'terms', 'signature'],
    properties: {
      contract_version: { type: 'string', const: '1.0' },
      contract_id: { type: 'string' },
      issuer: { type: 'string' },
      subject: { type: 'string' },
      terms: {
        type: 'object',
        required: ['action', 'max_duration_seconds'],
        properties: {
          action: { type: 'string' },
          max_duration_seconds: { type: 'integer', minimum: 1 },
          permitted_paths: { type: 'array', items: { type: 'string' } },
        },
      },
      signature: {
        type: 'object',
        required: ['key_id', 'algorithm', 'sig'],
        properties: {
          key_id: { type: 'string' },
          algorithm: { type: 'string', const: 'ed25519' },
          sig: { type: 'string' },
        },
      },
    },
  },
});

export function generateTemplate(type, options = {}) {
  const now = new Date();
  const idSuffix = crypto.randomBytes(8).toString('hex');
  const toEndpoint = options.to ?? 'ep_target';
  const toOwner = options['to-owner'] ?? 'usr_target';
  const fromEndpoint = options.from ?? 'ep_sender';
  const fromOwner = options['from-owner'] ?? 'usr_sender';
  const conversation = options.conversation ?? `conv_${idSuffix}`;

  switch (type) {
    case 'task':
    case 'task.request':
      return {
        protocol: 'sigil.task/v1',
        message_type: 'task.request',
        id: `env_${idSuffix}`,
        timestamp: now.toISOString(),
        conversation_id: conversation,
        sender: { endpoint_id: fromEndpoint, owner_id: fromOwner },
        recipient: { endpoint_id: toEndpoint, owner_id: toOwner },
        body: {
          task_id: `task_${idSuffix}`,
          instruction: options.instruction ?? 'Execute instructions',
          success_criteria: [],
          dependencies: [],
          deadline: new Date(now.getTime() + 86_400_000).toISOString(),
        },
      };
    case 'task.result':
      return {
        protocol: 'sigil.task/v1',
        message_type: 'task.result',
        id: `env_${idSuffix}`,
        timestamp: now.toISOString(),
        conversation_id: conversation,
        sender: { endpoint_id: fromEndpoint, owner_id: fromOwner },
        recipient: { endpoint_id: toEndpoint, owner_id: toOwner },
        body: {
          task_id: options.taskId ?? `task_${idSuffix}`,
          status: 'completed',
          output: 'Task completed successfully',
        },
      };
    case 'room.message':
      return {
        protocol: 'sigil.room/v1',
        message_type: 'room.message',
        id: `env_${idSuffix}`,
        timestamp: now.toISOString(),
        conversation_id: conversation,
        body: {
          text: options.text ?? 'Message content',
          mentions: options.mentions ? options.mentions.split(',') : [],
        },
      };
    case 'contract':
      return {
        contract_version: '1.0',
        contract_id: `contract_${idSuffix}`,
        issuer: fromOwner,
        subject: toEndpoint,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
        terms: {
          action: 'run-task',
          max_duration_seconds: 300,
          permitted_paths: ['src/'],
        },
        signature: {
          key_id: 'key_placeholder',
          algorithm: 'ed25519',
          sig: 'signature_base64_placeholder',
        },
      };
    default:
      throw new Error(`Unknown template type: "${type}". Supported types: ${Object.keys(SCHEMAS).join(', ')}`);
  }
}

export async function cmdSchema(argv) {
  const args = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const type = args.positionals[0] ?? 'all';
  if (type === 'all') {
    console.log(JSON.stringify(SCHEMAS, null, 2));
    return;
  }
  const schema = SCHEMAS[type];
  if (!schema) {
    throw new Error(`Unknown schema type: "${type}". Supported types: ${Object.keys(SCHEMAS).join(', ')}`);
  }
  console.log(JSON.stringify(schema, null, 2));
}

export async function cmdTemplate(argv) {
  const args = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      'to-owner': { type: 'string' },
      from: { type: 'string' },
      'from-owner': { type: 'string' },
      conversation: { type: 'string' },
      instruction: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const type = args.positionals[0];
  if (!type) {
    throw new Error(`usage: sigil template <type> [options]. Supported types: ${Object.keys(SCHEMAS).join(', ')}`);
  }
  const template = generateTemplate(type, args.values);
  const formatted = JSON.stringify(template, null, 2);
  if (args.values.out) {
    fs.writeFileSync(args.values.out, `${formatted}\n`, 'utf8');
    console.log(`Wrote template "${type}" to ${args.values.out}`);
  } else {
    console.log(formatted);
  }
}
