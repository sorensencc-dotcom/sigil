import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvitePage } from './InvitePage';
import { LoginPage } from './LoginPage';

describe('InvitePage', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('posts the token as a form field, keeps it out of the URL, and clears the fragment', () => {
    window.history.replaceState(null, '', '/invite#tok_secret');
    const replace = vi.spyOn(window.history, 'replaceState');
    const { container } = render(<InvitePage />);
    const form = container.querySelector('form')!;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form.getAttribute('action')).toBe('/v1/auth/oauth/github/start');
    expect((form.querySelector('input[name="invite"]') as HTMLInputElement).value).toBe('tok_secret');
    expect(replace).toHaveBeenCalled();
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain('tok_secret');
    expect(localStorage.length + sessionStorage.length).toBe(0);
    replace.mockRestore();
  });
});

describe('LoginPage', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('posts to start with no invite field', () => {
    const { container } = render(<LoginPage />);
    const form = container.querySelector('form')!;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form.getAttribute('action')).toBe('/v1/auth/oauth/github/start');
    expect(form.querySelector('input[name="invite"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument();
  });

  it('shows neutral copy per error code and never says whether an identity is linked', () => {
    const seen = new Map<string, string>();
    for (const code of ['denied', 'invite_required', 'invite_expired', 'provider_error']) {
      window.history.replaceState(null, '', `/login?error=${code}`);
      const { container, unmount } = render(<LoginPage />);
      const alert = container.querySelector('[role="alert"]');
      expect(alert, code).not.toBeNull();
      seen.set(code, alert!.textContent ?? '');
      expect(alert!.textContent).not.toMatch(/not linked|unknown|no account|not found|linked/i);
      unmount();
    }
    expect(new Set(seen.values()).size).toBe(4);
    window.history.replaceState(null, '', '/login?error=bogus');
    const { container } = render(<LoginPage />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe.each([
  ['LoginPage', LoginPage],
  ['InvitePage', InvitePage],
])('%s gate header', (_name, Page) => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('renders the branded title inside .gate-header', () => {
    const { container } = render(<Page />);
    expect(container.querySelector('.gate-header h1')).toHaveTextContent('Sigil rooms');
  });

  it('omits the theme toggle when no theme handler is given', () => {
    render(<Page />);
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull();
  });

  it('shows the theme toggle and reports the opposite theme on click', async () => {
    const onThemeChange = vi.fn();
    render(<Page theme="dark" onThemeChange={onThemeChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(onThemeChange).toHaveBeenCalledWith('light');
  });

  it('reads a theme saved by the retired picker as dark or light', async () => {
    const onThemeChange = vi.fn();
    render(<Page theme="cast-iron-charlie-light" onThemeChange={onThemeChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(onThemeChange).toHaveBeenCalledWith('dark');
  });
});
