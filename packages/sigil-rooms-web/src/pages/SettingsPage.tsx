import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAuth, useSelfEndpoint } from '../auth/AuthContext';
import type { Contact } from '../api/types';
import type { ApiClient } from '../api/client';
import { ErrorBanner } from '../errors/ErrorBanner';
import { contactsKey, useContacts } from '../rooms/useContacts';

interface EndpointOption {
  endpointId: string;
  displayName: string;
}

async function contactEndpoints(client: ApiClient, selfEndpoint: string | null, ownDisplayName: string | undefined): Promise<EndpointOption[]> {
  const endpoints = new Map<string, string>();
  const rooms = await client.listRooms();
  const roomMembers = await Promise.all(rooms.map((room) => client.listMembers(room.conversation_id)));
  for (const members of roomMembers) {
    for (const member of members) {
      if (!endpoints.has(member.endpoint_id)) endpoints.set(member.endpoint_id, member.display_name || member.endpoint_id);
    }
  }
  if (selfEndpoint) endpoints.set(selfEndpoint, ownDisplayName || endpoints.get(selfEndpoint) || selfEndpoint);
  return [...endpoints].map(([endpointId, displayName]) => ({ endpointId, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.endpointId.localeCompare(b.endpointId));
}

export function SettingsPage({ onBackToRooms }: { onBackToRooms: () => void }) {
  const { client, session } = useAuth();
  const selfEndpoint = useSelfEndpoint();
  const queryClient = useQueryClient();
  const contacts = useContacts();
  const endpointOptions = useQuery({
    queryKey: ['settings', 'contact-endpoints', selfEndpoint],
    queryFn: () => contactEndpoints(client, selfEndpoint, session?.display_name),
  });
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedDisplayName, setEditedDisplayName] = useState('');
  const addContact = useMutation({
    mutationFn: ({ login: nextLogin, displayName: nextDisplayName }: { login: string; displayName: string }) =>
      client.createContact(nextLogin, nextDisplayName),
    onSuccess: async () => {
      setLogin('');
      setDisplayName('');
      await queryClient.invalidateQueries({ queryKey: contactsKey });
    },
  });
  const updateContact = useMutation({
    mutationFn: ({ contactId, displayName: nextDisplayName }: { contactId: string; displayName: string }) =>
      client.updateContact(contactId, nextDisplayName),
    onSuccess: async (_contact, variables) => {
      setEditingId((current) => current === variables.contactId ? null : current);
      await queryClient.invalidateQueries({ queryKey: contactsKey });
    },
  });
  const deleteContact = useMutation({
    mutationFn: (contactId: string) => client.deleteContact(contactId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactsKey });
    },
  });

  function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addContact.mutate({ login: login.trim(), displayName: displayName.trim() });
  }

  function beginEdit(contact: Contact) {
    updateContact.reset();
    deleteContact.reset();
    setEditingId(contact.contact_id);
    setEditedDisplayName(contact.display_name);
  }

  return (
    <section className="settings-page">
      <header className="settings-header">
        <button type="button" className="ghost" onClick={onBackToRooms}>Back to rooms</button>
        <h1>Settings</h1>
      </header>
      <nav className="settings-tabs" role="tablist" aria-label="Settings">
        <button type="button" role="tab" aria-selected="true">Contacts</button>
      </nav>
      <section role="tabpanel" aria-label="Contacts" className="settings-content">
        <h2>Contacts</h2>
        <form className="contact-form" onSubmit={submitAdd}>
          <label>
            Login
            <input aria-label="Login" value={login} onChange={(event) => setLogin(event.currentTarget.value)} />
          </label>
          <label>
            Display name
            <input aria-label="New contact display name" value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
          </label>
          <label>
            Pick a visible endpoint
            <select
              aria-label="Pick a visible endpoint"
              value=""
              onChange={(event) => setLogin(event.currentTarget.value)}
            >
              <option value="">Choose an endpoint…</option>
              {(endpointOptions.data ?? []).map((endpoint) => (
                <option key={endpoint.endpointId} value={endpoint.endpointId}>
                  {endpoint.displayName} ({endpoint.endpointId})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={addContact.isPending}>Add contact</button>
          <ErrorBanner error={addContact.error} />
          {endpointOptions.error ? <ErrorBanner error={endpointOptions.error} /> : null}
        </form>

        {contacts.error ? <ErrorBanner error={contacts.error} /> : null}
        {contacts.isLoading ? <p>Loading contacts…</p> : null}
        {contacts.data && contacts.data.length === 0 ? <p className="empty">No contacts yet.</p> : null}
        {contacts.data && contacts.data.length > 0 ? (
          <div className="contact-table-wrap">
            <table className="contact-table">
              <thead>
                <tr><th scope="col">Login</th><th scope="col">Display name</th><th scope="col">Resolves to</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {contacts.data.map((contact) => {
                  const rowError = updateContact.variables?.contactId === contact.contact_id
                    ? updateContact.error
                    : deleteContact.variables === contact.contact_id ? deleteContact.error : null;
                  return (
                    <tr key={contact.contact_id}>
                      <td>{contact.login}</td>
                      <td>
                        {editingId === contact.contact_id ? (
                          <input
                              aria-label={`Edit display name for ${contact.login}`}
                              value={editedDisplayName}
                              onChange={(event) => setEditedDisplayName(event.currentTarget.value)}
                            />
                        ) : contact.display_name}
                        {rowError ? <ErrorBanner error={rowError} /> : null}
                      </td>
                      <td>{contact.endpoint_ids.length > 0 ? contact.endpoint_ids.join(', ') : 'none yet'}</td>
                      <td className="contact-actions">
                        {editingId === contact.contact_id ? (
                          <>
                            <button
                              type="button"
                              disabled={updateContact.isPending}
                              onClick={() => updateContact.mutate({ contactId: contact.contact_id, displayName: editedDisplayName.trim() })}
                            >
                              Save
                            </button>
                            <button type="button" className="ghost" onClick={() => setEditingId(null)}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => beginEdit(contact)}>Edit</button>
                            <button
                              type="button"
                              className="danger"
                              disabled={deleteContact.isPending}
                              onClick={() => {
                                if (window.confirm(`Delete contact "${contact.display_name}"?`)) {
                                  updateContact.reset();
                                  deleteContact.mutate(contact.contact_id);
                                }
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </section>
  );
}
