const TOKEN_KEY = 'sigil.token';
const SENDER_KEY = 'sigil.sender';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(SENDER_KEY);
}

export function getSender(): string | null {
  return sessionStorage.getItem(SENDER_KEY);
}

export function setSender(endpointId: string): void {
  sessionStorage.setItem(SENDER_KEY, endpointId);
}
