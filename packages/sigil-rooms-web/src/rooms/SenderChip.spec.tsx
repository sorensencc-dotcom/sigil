import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Contact, Member } from '../api/types';
import { SenderChip, actingForLabel, senderKind } from './SenderChip';
import { createOwnerNameFor } from './useContacts';

function member(endpointId: string, ownerId: string | null, responseMode: Member['response_mode'], displayName = endpointId): Member {
  return { endpoint_id: endpointId, role: 'member', response_mode: responseMode, added_at: 't', invokable_by: 'owner', owner_id: ownerId, display_name: displayName };
}

function contact(kind: Contact['kind'], login: string, displayName: string, endpointIds: string[] = []): Contact {
  return { contact_id: `ct_${login}`, kind, login, display_name: displayName, created_at: 't', updated_at: 't', endpoint_ids: endpointIds };
}

const members = [
  member('ep_chris', 'usr_chris', null, 'Chris'),
  member('ep_bot', 'usr_chris', 'joins', 'Chief'),
  member('ep_dana', 'usr_dana', null, 'Dana'),
  member('ep_dana_bot', 'usr_dana', 'mentions_only', 'Scout'),
  member('ep_orphan_bot', 'usr_gone', 'report_only', 'Orphan'),
];

describe('senderKind', () => {
  it('marks a member with a response mode as an agent', () => {
    expect(senderKind('ep_bot', members)).toBe('agent');
    expect(senderKind('ep_orphan_bot', members)).toBe('agent');
  });

  it('marks a member without a response mode as a human', () => {
    expect(senderKind('ep_chris', members)).toBe('human');
  });

  it('claims nothing for a sender outside the roster or before the roster loads', () => {
    expect(senderKind('ep_left', members)).toBe('unknown');
    expect(senderKind('ep_bot', [])).toBe('unknown');
  });
});

describe('actingForLabel', () => {
  it('names the owner from a human contact first', () => {
    const ownerNameFor = createOwnerNameFor([contact('human', 'usr_dana', 'Dana from contacts')]);
    expect(actingForLabel('usr_dana', { members, viewer: null, ownerNameFor })).toBe('Dana from contacts');
  });

  it('falls back to the owner human member in the room', () => {
    expect(actingForLabel('usr_dana', { members, viewer: null })).toBe('Dana');
  });

  it('falls back to the raw owner id when nobody in the room or contacts matches', () => {
    expect(actingForLabel('usr_gone', { members, viewer: null })).toBe('usr_gone');
  });

  it('says you when the agent acts for the viewer', () => {
    expect(actingForLabel('usr_chris', { members, viewer: 'ep_chris' })).toBe('you');
  });

  it('returns null when the owner is unknown', () => {
    expect(actingForLabel(null, { members, viewer: null })).toBeNull();
    expect(actingForLabel('', { members, viewer: null })).toBeNull();
  });
});

describe('SenderChip', () => {
  it('shows an agent mark and the acting-for line', () => {
    render(<SenderChip endpointId="ep_dana_bot" ownerId="usr_dana" name="Scout" members={members} viewer={null} />);
    expect(screen.getByText('Scout')).toHaveClass('sender');
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('acting for Dana')).toBeInTheDocument();
  });

  it('shows a human mark and no acting-for line', () => {
    render(<SenderChip endpointId="ep_dana" ownerId="usr_dana" name="Dana" members={members} viewer={null} />);
    expect(screen.getByText('Human')).toBeInTheDocument();
    expect(screen.queryByText(/acting for/)).toBeNull();
  });

  it('shows no mark for an unknown sender', () => {
    render(<SenderChip endpointId="ep_left" ownerId="usr_x" name="Left" members={members} viewer={null} />);
    expect(screen.getByText('Left')).toBeInTheDocument();
    expect(screen.queryByText('Human')).toBeNull();
    expect(screen.queryByText('Agent')).toBeNull();
    expect(screen.queryByText(/acting for/)).toBeNull();
  });

  it('says acting for you on the viewer own agent', () => {
    render(<SenderChip endpointId="ep_bot" ownerId="usr_chris" name="Chief" members={members} viewer="ep_chris" />);
    expect(screen.getByText('acting for you')).toBeInTheDocument();
  });
});
