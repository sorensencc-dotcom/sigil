import { useEffect, useState } from 'react';
import { START_URL } from './startUrl';

// The invite token lives only in the URL fragment, which the browser never sends to a server.
// It is held in memory for the form post and the fragment is cleared right away.
let heldInvite = '';

/** Moves an /invite fragment into memory and clears it from the address bar. Safe to call repeatedly. */
export function captureInviteFragment(): string {
  if (window.location.pathname === '/invite' && window.location.hash.length > 1) {
    heldInvite = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return heldInvite;
}

export function InvitePage() {
  const [invite] = useState(() => captureInviteFragment());
  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  return (
    <main className="gate">
      <h1>Sigil rooms</h1>
      <p>You have been invited to Sigil rooms. Continue with GitHub to accept.</p>
      <form method="post" action={START_URL}>
        <input type="hidden" name="invite" value={invite} />
        <button type="submit">Continue with GitHub</button>
      </form>
    </main>
  );
}
