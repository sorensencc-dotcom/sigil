import type { PinnedKey } from './verifyRow';

// Pins live in this browser, never on the relay: a compromised relay cannot rewrite them.
const KEY = 'sigil.keyPins';

function load(): Record<string, PinnedKey> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PinnedKey>) : {};
  } catch {
    return {};
  }
}

export function getPin(endpointId: string): PinnedKey | null {
  const pin = Object.hasOwn(load(), endpointId) ? load()[endpointId] : null;
  return pin && typeof pin.key_id === 'string' && typeof pin.public_key === 'string' ? pin : null;
}

export function setPin(endpointId: string, pin: PinnedKey | null): void {
  const pins = load();
  if (pin) pins[endpointId] = pin; else delete pins[endpointId];
  try { localStorage.setItem(KEY, JSON.stringify(pins)); } catch { /* ignore */ }
}
