import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { Composer } from './Composer';
import { previewRecipients } from './recipientPreview';

const member = (endpoint_id: string, display_name: string, over: Partial<Member> = {}): Member => ({
  endpoint_id, display_name, role: 'member', response_mode: null, added_at: 't', invokable_by: 'members', owner_id: null, ...over,
});
const nameFor = (_id: string, fallback?: string) => fallback || _id;
const loginFor = () => null;

const human = member('ep_hana', 'Hana');
const joins = member('ep_jo', 'Jo', { response_mode: 'joins' });
const mentionsOnly = member('ep_mo', 'Mo', { response_mode: 'mentions_only' });
const router = member('ep_rt', 'Router', { response_mode: 'router' });
const report = member('ep_rp', 'Reporter', { response_mode: 'report_only' });
const ownerOnly = member('ep_oo', 'Olly', { response_mode: 'mentions_only', invokable_by: 'owner', owner_id: 'h_owner' });

describe('previewRecipients', () => {
  it('wakes mentioned agents and lists unmentioned ones as not waking', () => {
    const result = previewRecipients('hi @Mo', [human, joins, mentionsOnly, router], 'h_me', nameFor, loginFor);
    expect(result.willWake.map((e) => e.name)).toEqual(['Mo']);
    expect(result.routerPicksFrom).toBeNull();
    expect(result.wontWake).toEqual([{ endpointId: 'ep_jo', name: 'Jo', reason: 'not mentioned' }]);
  });

  it('predicts a router pick among joins agents when nothing is mentioned', () => {
    const result = previewRecipients('hello', [human, joins, mentionsOnly, router, report], 'h_me', nameFor, loginFor);
    expect(result.routerPicksFrom?.map((e) => e.name)).toEqual(['Jo']);
    expect(result.willWake).toEqual([]);
    expect(result.wakesNobody).toBe(false);
    expect(result.wontWake.map((e) => e.name)).toEqual(['Mo', 'Reporter']);
  });

  it('wakes nobody without a router, and treats null-mode members as humans', () => {
    const result = previewRecipients('hello', [human, joins], 'h_me', nameFor, loginFor);
    expect(result.wakesNobody).toBe(true);
    expect([...result.willWake, ...result.wontWake].some((e) => e.name === 'Hana')).toBe(false);
  });

  it('applies invokable_by against the sender', () => {
    const asStranger = previewRecipients('@Olly', [ownerOnly], 'h_me', nameFor, loginFor);
    expect(asStranger.willWake).toEqual([]);
    expect(asStranger.wontWake[0]?.reason).toBe('only its owner can invoke it');
    const asOwner = previewRecipients('@Olly', [ownerOnly], 'h_owner', nameFor, loginFor);
    expect(asOwner.willWake.map((e) => e.name)).toEqual(['Olly']);
    const unknown = previewRecipients('@Olly', [ownerOnly], null, nameFor, loginFor);
    expect(unknown.willWake).toEqual([]);
  });

  it('drops the router when the sender may not invoke it', () => {
    const lockedRouter = member('ep_rt', 'Router', { response_mode: 'router', invokable_by: 'owner', owner_id: 'h_owner' });
    const result = previewRecipients('hello', [joins, lockedRouter], 'h_me', nameFor, loginFor);
    expect(result.routerPicksFrom).toBeNull();
    expect(result.wakesNobody).toBe(true);
  });

  it('does not wake report_only or router members by mention', () => {
    const result = previewRecipients('@Reporter @Router', [report, router], 'h_me', nameFor, loginFor);
    expect(result.willWake).toEqual([]);
    expect(result.wontWake.map((e) => e.name)).toEqual(['Reporter', 'Router']);
  });

  it('disambiguates duplicate names and ignores an ambiguous bare mention', () => {
    const a = member('ep_a', 'Sam', { response_mode: 'mentions_only' });
    const b = member('ep_b', 'Sam', { response_mode: 'mentions_only' });
    const bare = previewRecipients('@Sam', [a, b], 'h_me', nameFor, loginFor);
    expect(bare.willWake).toEqual([]);
    const picked = previewRecipients('@Sam (ep_b)', [a, b], 'h_me', nameFor, loginFor);
    expect(picked.willWake).toEqual([{ endpointId: 'ep_b', name: 'Sam (ep_b)' }]);
    expect(picked.wontWake.map((e) => e.name)).toEqual(['Sam (ep_a)']);
  });

  it('only considers the members it is given, so a removed member never appears', () => {
    const result = previewRecipients('@Mo', [human, joins], 'h_me', nameFor, loginFor);
    expect(result.willWake).toEqual([]);
    expect([...result.willWake, ...result.wontWake].some((e) => e.name === 'Mo')).toBe(false);
  });
});

describe('Composer recipient preview', () => {
  it('shows nothing until text is typed, then words the router result as a prediction', async () => {
    renderWithClient(<Composer send={() => {}} disabledReason={null} members={[human, joins, router]} />, {});
    expect(screen.queryByRole('group', { name: 'Recipient preview' })).toBeNull();
    await userEvent.type(screen.getByRole('textbox'), 'anyone?');
    const group = screen.getByRole('group', { name: 'Recipient preview' });
    expect(group).toHaveTextContent('The router decides who answers. It may pick from Jo.');
    expect(group).not.toHaveTextContent('Will wake');
  });

  it('shows Will wake for a mention and updates as the text changes', async () => {
    renderWithClient(<Composer send={() => {}} disabledReason={null} members={[human, mentionsOnly, joins, router]} />, {});
    await userEvent.type(screen.getByRole('textbox'), 'ping @Mo ');
    const group = screen.getByRole('group', { name: 'Recipient preview' });
    expect(group).toHaveTextContent('Will wake: Mo');
    expect(group).toHaveTextContent("Won't wake: Jo (not mentioned)");
  });

  it('is hidden in rooms that hold only humans', async () => {
    renderWithClient(<Composer send={() => {}} disabledReason={null} members={[human]} />, {});
    await userEvent.type(screen.getByRole('textbox'), 'hi');
    expect(screen.queryByRole('group', { name: 'Recipient preview' })).toBeNull();
  });
});
