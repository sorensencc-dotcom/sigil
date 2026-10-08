import { useState } from 'react';

export function Composer({ send, disabledReason }: { send: (text: string) => void; disabledReason: string | null }) {
  const [text, setText] = useState('');
  const disabled = disabledReason !== null;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = text.trim();
        if (!trimmed || disabled) return;
        send(trimmed);
        setText('');
      }}
    >
      {disabledReason ? <p className="reason">{disabledReason}</p> : null}
      <textarea aria-label="Message" value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} />
      <button type="submit" disabled={disabled}>Send</button>
    </form>
  );
}
