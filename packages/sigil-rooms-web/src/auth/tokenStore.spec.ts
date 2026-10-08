import { describe, expect, it } from 'vitest';
import { clearToken, getSender, getToken, setSender, setToken } from './tokenStore';

describe('tokenStore', () => {
  it('keeps the token in sessionStorage and never in localStorage', () => {
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(sessionStorage.getItem('sigil.token')).toBe('abc');
    expect(localStorage.length).toBe(0);
  });

  it('clearToken removes the token and the sender', () => {
    setToken('abc');
    setSender('ep_web');
    clearToken();
    expect(getToken()).toBeNull();
    expect(getSender()).toBeNull();
  });

  it('trims the pasted token', () => {
    setToken('  abc \n');
    expect(getToken()).toBe('abc');
  });
});
