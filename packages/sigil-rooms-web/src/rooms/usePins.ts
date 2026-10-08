import { useCallback, useState } from 'react';

const PINS_KEY = 'sigil.pins';

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function usePins() {
  const [pins, setPins] = useState<string[]>(load);
  const toggle = useCallback((roomId: string) => {
    setPins((current) => {
      const next = current.includes(roomId) ? current.filter((id) => id !== roomId) : [...current, roomId];
      try {
        localStorage.setItem(PINS_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);
  return { pins, toggle };
}
