import { useState } from 'react';

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
      <div className="gate-header">
        <h1>Sigil rooms</h1>
        {onThemeChange && theme ? (
          <select
            aria-label="Theme"
            className="theme-select"
            value={theme}
            onChange={(e) => onThemeChange(e.target.value)}
          >
            <option value="rewrite-labs">Rewrite Labs</option>
            <option value="cast-iron-charlie">Cast Iron Charlie (Dark)</option>
            <option value="cast-iron-charlie-light">Cast Iron Charlie (Paper)</option>
          </select>
        ) : null}
      </div>
      {rejected ? <p role="alert">Token rejected</p> : null}
      <label>
        Bearer token
        <input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button type="submit">Connect</button>
    </form>
  );
}
