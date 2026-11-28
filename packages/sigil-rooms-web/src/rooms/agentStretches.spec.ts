import { describe, expect, it } from 'vitest';
import type { HistoryItem, Member } from '../api/types';
import { classifyRow, groupAgentStretches, type StretchPart } from './agentStretches';
import type { Row } from './mergeRows';

const members: Member[] = [
  { endpoint_id: 'ep_bot1', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'members', owner_id: 'u1', display_name: 'Bot 1' },
  { endpoint_id: 'ep_bot2', role: 'member', response_mode: 'mentions_only', added_at: 't', invokable_by: 'members', owner_id: 'u2', display_name: 'Bot 2' },
  { endpoint_id: 'ep_hana', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: 'u1', display_name: 'Hana' },
];

let seq = 0;
function row(sender: string, kind?: string): Row {
  seq += 1;
  const id = `m${seq}`;
  const item: HistoryItem = {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: {
      message_id: id,
      message_type: kind ? 'room.event' : 'room.message',
      sender: { endpoint_id: sender, owner_id: 'u' },
      body: kind ? { kind } : { text: id },
      created_at: 't',
    },
  };
  return { key: `seq:${seq}`, seq: BigInt(seq), item };
}
const agent = (n: 1 | 2) => row(`ep_bot${n}`);
const human = () => row('ep_hana');
const stranger = () => row('ep_unknown');
const event = (kind: string) => row('ep_relay', kind);
const pending = (): Row => ({ key: 'pending:k', seq: null, item: null, pending: { idempotencyKey: 'k', text: 'hi', status: 'sending' } });

function group(rows: Row[], options = {}) {
  return groupAgentStretches(rows, (r) => classifyRow(r, members), options);
}
function shape(parts: StretchPart<Row>[]) {
  return parts.map((part) => part.kind === 'single' ? 'single' : `stretch(${part.agents.length}${part.flags.length ? `:${part.flags.join(',')}` : ''})`);
}

describe('groupAgentStretches', () => {
  it('leaves two agent messages inline and folds three', () => {
    expect(shape(group([agent(1), agent(2)]))).toEqual(['single', 'single']);
    expect(shape(group([agent(1), agent(2), agent(1)]))).toEqual(['stretch(3)']);
  });

  it('keys a stretch by its first message id and keeps every row', () => {
    const rows = [agent(1), agent(2), agent(1), agent(2)];
    const [part] = group(rows);
    expect(part).toMatchObject({ kind: 'stretch', firstId: rows[0]!.item!.message_id, key: `stretch:${rows[0]!.item!.message_id}` });
    expect(part?.kind === 'stretch' && part.entries).toEqual(rows);
  });

  it('breaks a stretch on a human message', () => {
    expect(shape(group([agent(1), agent(2), human(), agent(1), agent(2)]))).toEqual(['single', 'single', 'single', 'single', 'single']);
    expect(shape(group([agent(1), agent(2), agent(1), human(), agent(2)]))).toEqual(['stretch(3)', 'single', 'single']);
  });

  it('breaks a stretch on a sender outside the roster and on a pending post', () => {
    expect(shape(group([agent(1), agent(2), stranger(), agent(1)]))).toEqual(['single', 'single', 'single', 'single']);
    expect(shape(group([agent(1), agent(2), pending(), agent(1)]))).toEqual(['single', 'single', 'single', 'single']);
  });

  it('flags a stretch that a cap event sits inside or ends', () => {
    expect(shape(group([agent(1), agent(2), event('agent_cap_reached'), agent(1)]))).toEqual(['stretch(3:cap)']);
    // A trailing cap row stays outside the stretch but still flags it.
    expect(shape(group([agent(1), agent(2), agent(1), event('agent_cap_reached')]))).toEqual(['stretch(3:cap)', 'single']);
    expect(shape(group([agent(1), agent(2), agent(1), event('room_halted')]))).toEqual(['stretch(3:halted)', 'single']);
  });

  it('rides other room events inside a stretch without counting them', () => {
    const parts = group([agent(1), event('router_decision'), agent(2), event('router_decision')]);
    expect(shape(parts)).toEqual(['single', 'single', 'single', 'single']);
    const folded = group([agent(1), event('router_decision'), agent(2), agent(1)]);
    expect(shape(folded)).toEqual(['stretch(3)']);
    const first = folded[0];
    expect(first?.kind === 'stretch' && first.events).toBe(1);
  });

  it('flags a stretch holding a failed signature or a focused row', () => {
    const rows = [agent(1), agent(2), agent(1)];
    const failedId = rows[1]!.item!.message_id;
    expect(shape(group(rows, { isFailed: (id: string) => id === failedId }))).toEqual(['stretch(3:failed)']);
    expect(shape(group(rows, { isForcedOpen: (id: string) => id === failedId }))).toEqual(['stretch(3:focus)']);
  });
  it('keeps a stretch open when a pending hold belongs to it, its trailing event rows included (#269)', () => {
    const rows = [agent(1), agent(2), agent(1), event('approval_requested')];
    const cardId = rows[3]!.item!.message_id;
    const seen: string[][] = [];
    const isHeld = (ids: readonly string[]) => { seen.push([...ids]); return ids.includes(cardId); };
    expect(shape(group(rows, { isHeld }))).toEqual(['stretch(3:held)', 'single']);
    expect(seen[0]).toContain(cardId);
    expect(shape(group(rows, { isHeld: () => false }))).toEqual(['stretch(3)', 'single']);
  });
});
