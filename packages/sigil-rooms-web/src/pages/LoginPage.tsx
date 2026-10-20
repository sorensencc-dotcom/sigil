import { GateHeader } from '../auth/GateHeader';
import { START_URL } from './startUrl';

// Neutral wording on purpose: denied covers "not linked" and "not allowed" alike.
const ERROR_COPY: Record<string, string> = {
  denied: 'Sign-in was not completed. Ask the room operator for an invite link if you need access.',
  invite_required: 'An invite link is required to sign in. Ask the room operator for one.',
  invite_expired: 'That invite link is no longer valid. Ask the room operator for a new one.',
  provider_error: 'GitHub could not complete the sign-in. Try again in a moment.',
};

export function LoginPage({ theme, onThemeChange }: { theme?: string; onThemeChange?: (next: string) => void }) {
  const code = new URLSearchParams(window.location.search).get('error');
  const message = code && Object.prototype.hasOwnProperty.call(ERROR_COPY, code) ? ERROR_COPY[code] : null;
  return (
    <main className="gate">
      <GateHeader theme={theme} onThemeChange={onThemeChange} />
      {message ? <p role="alert" className="error">{message}</p> : null}
      <form method="post" action={START_URL}>
        <button type="submit">Continue with GitHub</button>
      </form>
    </main>
  );
}
