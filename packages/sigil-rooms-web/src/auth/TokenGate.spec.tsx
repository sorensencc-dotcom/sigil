import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TokenGate } from './TokenGate';

describe('TokenGate', () => {
  it('submits the pasted token', async () => {
    const onSubmit = vi.fn();
    render(<TokenGate onSubmit={onSubmit} rejected={false} />);
    await userEvent.type(screen.getByLabelText(/bearer token/i), 'secret-token');
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onSubmit).toHaveBeenCalledWith('secret-token');
  });

  it('does not submit an empty token', async () => {
    const onSubmit = vi.fn();
    render(<TokenGate onSubmit={onSubmit} rejected={false} />);
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows "Token rejected" after a 401', () => {
    render(<TokenGate onSubmit={() => {}} rejected />);
    expect(screen.getByRole('alert')).toHaveTextContent('Token rejected');
  });

  it('masks the token field', () => {
    render(<TokenGate onSubmit={() => {}} rejected={false} />);
    expect(screen.getByLabelText(/bearer token/i)).toHaveAttribute('type', 'password');
  });
});
