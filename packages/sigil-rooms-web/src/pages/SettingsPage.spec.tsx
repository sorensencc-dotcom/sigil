import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import type { Contact, Member, Room } from '../api/types';
import { TestAuthProvider } from '../auth/AuthContext';
import { SettingsPage } from './SettingsPage';

const contact = (overrides: Partial<Contact> = {}): Contact => ({
  contact_id: 'ct_ada',
  kind: 'endpoint',
  login: 'ep_ada',
  display_name: 'Ada',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  endpoint_ids: ['ep_ada'],
  ...overrides,
});

const rooms: Room[] = [
  { conversation_id: 'room_1', workspace_id: 'ws', name: 'one', description: null, created_at: '', max_agent_turns: 10 },
  { conversation_id: 'room_2', workspace_id: 'ws', name: 'two', description: null, created_at: '', max_agent_turns: 10 },
];

const members: Member[] = [
  { endpoint_id: 'ep_self', role: 'owner', response_mode: null, added_at: '', invokable_by: 'owner', owner_id: null, display_name: 'Viewer' },
  { endpoint_id: 'ep_member', role: 'member', response_mode: null, added_at: '', invokable_by: 'members', owner_id: null, display_name: 'Member' },
];

function renderSettings(client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider
        client={client as ApiClient}
        mode="cookie"
        session={{ human_id: 'human', endpoint_id: 'ep_self', display_name: 'Viewer', is_operator: false }}
      >
        <SettingsPage onBackToRooms={() => {}} />
      </TestAuthProvider>
    </QueryClientProvider>,
  );
}

function mockClient(overrides: Partial<ApiClient> = {}): Partial<ApiClient> {
  return {
    listContacts: vi.fn(async () => [contact()]),
    listRooms: vi.fn(async () => rooms),
    listMembers: vi.fn(async () => members),
    createContact: vi.fn(async () => contact()),
    updateContact: vi.fn(async () => contact()),
    deleteContact: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('SettingsPage contacts', () => {
  it('renders contacts and their endpoint resolutions', async () => {
    renderSettings(mockClient({
      listContacts: vi.fn(async () => [
        contact({ endpoint_ids: ['ep_ada', 'ep_alt'] }),
        contact({ contact_id: 'ct_email', kind: 'email', login: 'ada@example.test', display_name: 'Ada email', endpoint_ids: [] }),
      ]),
    }));
    const row = await screen.findByRole('row', { name: /ep_ada/ });
    expect(within(row).getByRole('cell', { name: 'ep_ada' })).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: 'ep_ada, ep_alt' })).toBeInTheDocument();
    expect(screen.getByText('none yet')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Resolves to' })).toBeInTheDocument();
  });

  it('adds a contact and invalidates the contacts query for a refetch', async () => {
    let saved = [contact()];
    const listContacts = vi.fn(async () => saved);
    const createContact = vi.fn(async (login: string, displayName: string) => {
      const created = contact({ contact_id: 'ct_new', login, display_name: displayName, endpoint_ids: [] });
      saved = [...saved, created];
      return created;
    });
    renderSettings(mockClient({ listContacts, createContact }));
    await screen.findByRole('row', { name: /ep_ada/ });
    await userEvent.type(screen.getByRole('textbox', { name: 'Login' }), 'new_login');
    await userEvent.type(screen.getByRole('textbox', { name: 'New contact display name' }), 'New Person');
    await userEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(await screen.findByText('new_login')).toBeInTheDocument();
    expect(createContact).toHaveBeenCalledWith('new_login', 'New Person');
    await waitFor(() => expect(listContacts.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it.each([
    ['409', 'CONTACT_LOGIN_EXISTS', 'That login already exists'],
    ['400', 'INVALID_DISPLAY_NAME', 'Display name is invalid'],
  ])('shows a %s add error inline', async (_status, code, message) => {
    renderSettings(mockClient({
      createContact: vi.fn(async () => { throw new ApiError(code, Number(_status), message); }),
    }));
    await screen.findByRole('row', { name: /ep_ada/ });
    await userEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('fills the login when a visible endpoint is picked and deduplicates options', async () => {
    const listMembers = vi.fn(async (roomId: string) => roomId === 'room_1'
      ? members
      : [
          members[1]!,
          { endpoint_id: 'ep_guest', role: 'member' as const, response_mode: null, added_at: '', invokable_by: 'members' as const, owner_id: null, display_name: 'Guest' },
        ]);
    renderSettings(mockClient({
      listRooms: vi.fn(async () => rooms),
      listMembers,
    }));
    const picker = await screen.findByRole('combobox', { name: 'Pick a visible endpoint' });
    await screen.findByRole('option', { name: 'Viewer (ep_self)' });
    expect(await screen.findByRole('option', { name: 'Guest (ep_guest)' })).toBeInTheDocument();
    expect(listMembers).toHaveBeenCalledWith('room_1');
    expect(listMembers).toHaveBeenCalledWith('room_2');
    expect(within(picker).getAllByRole('option', { name: /ep_self/ })).toHaveLength(1);
    expect(within(picker).getByRole('option', { name: 'Viewer (ep_self)' })).toBeInTheDocument();
    await userEvent.selectOptions(picker, 'ep_member');
    expect(screen.getByRole('textbox', { name: 'Login' })).toHaveValue('ep_member');
  });

  it('updates a display name inline', async () => {
    let saved = contact();
    const updateContact = vi.fn(async (contactId: string, displayName: string) => {
      saved = contact({ contact_id: contactId, display_name: displayName });
      return saved;
    });
    renderSettings(mockClient({ listContacts: vi.fn(async () => [saved]), updateContact }));
    const row = await screen.findByRole('row', { name: /ep_ada/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Edit display name for ep_ada' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Edit display name for ep_ada' }), 'Ada Lovelace');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(updateContact).toHaveBeenCalledWith('ct_ada', 'Ada Lovelace');
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('deletes after confirmation and leaves the contact when confirmation is cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    let saved = [contact()];
    const listContacts = vi.fn(async () => saved);
    const deleteContact = vi.fn(async (_contactId: string) => {});
    const view = renderSettings(mockClient({
      listContacts,
      deleteContact: vi.fn(async (contactId: string) => {
        await deleteContact(contactId);
        saved = [];
      }),
    }));
    confirm.mockReturnValue(false);
    const row = await screen.findByRole('row', { name: /ep_ada/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith('Delete contact "Ada"?');
    expect(deleteContact).not.toHaveBeenCalled();
    expect(row).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteContact).toHaveBeenCalledWith('ct_ada'));
    expect(await screen.findByText('No contacts yet.')).toBeInTheDocument();
  });

  it('shows a delete 404 inline with the contact row', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings(mockClient({
      deleteContact: vi.fn(async () => { throw new ApiError('CONTACT_NOT_FOUND', 404, 'Contact not found'); }),
    }));
    const row = await screen.findByRole('row', { name: /ep_ada/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Contact not found');
  });
});
