import { ApiError } from '../api/client';

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'Something went wrong';
  switch (error.code) {
    case 'HUMAN_CONTEXT_REQUIRED': return 'This token is not a human token';
    case 'ROOM_SEND_UNAVAILABLE': return 'Sending is not configured. Start the relay with --room-human-identity.';
    case 'NO_SIGNING_KEY': return 'This token\'s endpoint is not the identity loaded with --room-human-identity.';
    case 'ROOM_NAME_TAKEN': return 'A room with that name already exists';
    case 'ROUTE_NOT_AUTHORIZED': return 'Only room managers can do this';
    case 'DATABASE_UNAVAILABLE': return 'Rooms are unavailable (DATABASE_UNAVAILABLE)';
    case 'NETWORK': return error.message;
    default: return error.message || error.code;
  }
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert">{describeError(error)}</p>;
}
