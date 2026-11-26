import type { Member } from '../api/types';
import type { Row } from './mergeRows';
import { senderKind } from './SenderChip';

// Folds runs of agent-to-agent messages into one card (plan story 8). Pure, so Timeline and
// ThreadPanel share one rule set and the fold is recomputed from current rows on every render.

export const FOLD_THRESHOLD = 3;

export type StretchFlag = 'cap' | 'halted' | 'failed' | 'focus';

export type Classified =
  | { role: 'agent'; id: string }
  | { role: 'event'; id: string; flag: 'cap' | 'halted' | null }
  | { role: 'break' };

export type StretchPart<T> =
  | { kind: 'single'; entry: T }
  | { kind: 'stretch'; key: string; firstId: string; entries: T[]; agents: T[]; events: number; flags: StretchFlag[] };

export interface GroupOptions {
  threshold?: number;
  // True when a check that already ran found this row's signature bad.
  isFailed?: (messageId: string) => boolean;
  // True when something else on screen points at this row (mention focus, search hit, open envelope).
  isForcedOpen?: (messageId: string) => boolean;
}

// Room events ride inside a run without counting toward the threshold, so a cap event can sit
// inside or at the end of one. Humans, senders outside the roster, and pending posts end a run.
export function classifyRow(row: Row, members: Member[]): Classified {
  const item = row.item;
  if (row.pending || !item) return { role: 'break' };
  const { envelope } = item;
  if (envelope.message_type === 'room.event') {
    const kind = envelope.body.kind;
    return { role: 'event', id: item.message_id, flag: kind === 'agent_cap_reached' ? 'cap' : kind === 'room_halted' ? 'halted' : null };
  }
  if (envelope.message_type === 'room.message' && senderKind(envelope.sender.endpoint_id, members) === 'agent') {
    return { role: 'agent', id: item.message_id };
  }
  return { role: 'break' };
}

export function groupAgentStretches<T>(entries: readonly T[], classify: (entry: T) => Classified, options: GroupOptions = {}): StretchPart<T>[] {
  const { threshold = FOLD_THRESHOLD, isFailed = () => false, isForcedOpen = () => false } = options;
  const parts: StretchPart<T>[] = [];
  let run: { entry: T; info: Exclude<Classified, { role: 'break' }> }[] = [];

  const flush = () => {
    let end = run.length;
    while (end > 0 && run[end - 1]!.info.role === 'event') end -= 1;
    const body = run.slice(0, end);
    const tail = run.slice(end);
    const agents = body.filter(({ info }) => info.role === 'agent');
    if (agents.length >= threshold) {
      const flags = new Set<StretchFlag>();
      for (const { info } of run) {
        if (info.role === 'event' && info.flag) flags.add(info.flag);
      }
      for (const { info } of body) {
        if (isFailed(info.id)) flags.add('failed');
        if (isForcedOpen(info.id)) flags.add('focus');
      }
      const firstId = body[0]!.info.id;
      parts.push({
        kind: 'stretch',
        key: `stretch:${firstId}`,
        firstId,
        entries: body.map(({ entry }) => entry),
        agents: agents.map(({ entry }) => entry),
        events: body.length - agents.length,
        flags: [...flags],
      });
    } else {
      for (const { entry } of body) parts.push({ kind: 'single', entry });
    }
    for (const { entry } of tail) parts.push({ kind: 'single', entry });
    run = [];
  };

  for (const entry of entries) {
    const info = classify(entry);
    if (info.role === 'break') {
      flush();
      parts.push({ kind: 'single', entry });
    } else if (info.role === 'event' && run.length === 0) {
      parts.push({ kind: 'single', entry });
    } else {
      run.push({ entry, info });
    }
  }
  flush();
  return parts;
}
