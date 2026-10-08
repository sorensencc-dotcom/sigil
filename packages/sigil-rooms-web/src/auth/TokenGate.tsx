import { useState } from 'react';

export function TokenGate({ onSubmit, rejected }: { onSubmit: (token: string) => void; rejected: boolean }) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <h1>Sigil rooms</h1>
      {rejected ? <p role="alert">Token rejected</p> : null}
      <label>
        Bearer token
        <input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button type="submit">Connect</button>
    </form>
  );
}
