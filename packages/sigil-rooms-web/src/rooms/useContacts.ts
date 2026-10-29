import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import type { Contact } from '../api/types';

export type NameFor = (endpointId: string, fallbackDisplayName?: string) => string;
export type LoginFor = (endpointId: string) => string | null;

export const contactsKey = ['me', 'contacts'] as const;

function contactFor(contacts: Contact[], endpointId: string): Contact | undefined {
  return contacts.find((contact) => contact.kind === 'endpoint' && contact.login === endpointId)
    ?? contacts.find((contact) => contact.kind === 'human' && contact.endpoint_ids.includes(endpointId));
}

export function createLoginFor(contacts: Contact[]): LoginFor {
  return (endpointId) => contactFor(contacts, endpointId)?.login ?? null;
}

export function createNameFor(contacts: Contact[]): NameFor {
  const loginFor = createLoginFor(contacts);
  return (endpointId, fallbackDisplayName) => {
    const contact = contactFor(contacts, endpointId);
    if (!contact) return fallbackDisplayName || endpointId;
    const displayName = contact.display_name || fallbackDisplayName || endpointId;
    const logins = new Set(
      contacts
        .filter((candidate) =>
          (candidate.kind === 'endpoint' || candidate.kind === 'human')
          && candidate.display_name === contact.display_name
          && candidate.login,
        )
        .map((candidate) => candidate.login!),
    );
    const login = loginFor(endpointId);
    return logins.size > 1 && login ? `${displayName} (${login})` : displayName;
  };
}

export function useContacts() {
  const { client } = useAuth();
  const query = useQuery({ queryKey: contactsKey, queryFn: () => client.listContacts() });
  return { ...query, nameFor: createNameFor(query.data ?? []), loginFor: createLoginFor(query.data ?? []) };
}
