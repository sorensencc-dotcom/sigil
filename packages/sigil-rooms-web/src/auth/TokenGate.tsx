import { useState } from 'react';
import { GateHeader } from './GateHeader';

export function TokenGate({
  onSubmit,
  rejected,
  theme,
  onThemeChange,
}: {
  onSubmit: (token: string) => void;
  rejected: boolean;
  theme?: string;
  onThemeChange?: (next: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      className="gate"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <GateHeader theme={theme} onThemeChange={onThemeChange} />
      {rejected ? <p role="alert">Token rejected</p> : null}
      <label>
        Bearer token
        <input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button type="submit">Connect</button>
    </form>
  );
}
