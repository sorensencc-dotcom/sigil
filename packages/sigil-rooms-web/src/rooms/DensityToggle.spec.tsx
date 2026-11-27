import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DensityToggle } from './DensityToggle';

describe('DensityToggle', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.density;
  });

  it('starts comfortable and switches the page to compact', async () => {
    render(<DensityToggle />);
    const button = screen.getByRole('button', { name: 'Comfortable' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement.dataset.density).toBe('comfortable');
    await userEvent.click(button);
    expect(screen.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(localStorage.getItem('sigil.density')).toBe('compact');
  });
});
