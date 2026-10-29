import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../api/types';
import { RowView } from './RowView';

function row(displayName: string | undefined): { key: string; seq: bigint; item: HistoryItem } {
  return {
    key: 'm1',
    seq: 1n,
    item: {
      room_seq: '1',
      message_id: 'm1',
      canonical_bytes: 'c',
      ...(displayName === undefined ? {} : { display_name: displayName }),
      envelope: { message_id: 'm1', message_type: 'room.message', sender: { endpoint_id: 'ep_ada', owner_id: 'usr_a' }, body: { text: 'hi' }, created_at: '2026-10-12T00:00:00Z' },
    },
  };
}

function replyItem(overrides: Partial<HistoryItem> & { text?: string; endpoint?: string; display?: string } = {}): HistoryItem {
  const endpoint = overrides.endpoint ?? 'ep_chief';
  const text = overrides.text ?? 'pong';
  return {
    room_seq: '2',
    message_id: 'r2',
    canonical_bytes: 'c',
    ...(overrides.display === undefined ? {} : { display_name: overrides.display }),
    envelope: {
      message_id: 'r2',
      message_type: 'room.message',
      sender: { endpoint_id: endpoint, owner_id: 'u' },
      body: { text, thread_root_id: 'm1' },
      created_at: '2026-10-12T00:01:00Z',
    },
  };
}

describe('RowView', () => {
  it('shows the sender display name instead of the endpoint id', () => {
    render(<ul><RowView row={row('Ada')} sender={null} /></ul>);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.queryByText('ep_ada')).toBeNull();
  });

  it('falls back to the endpoint id when no display name is present', () => {
    render(<ul><RowView row={row(undefined)} sender={null} /></ul>);
    expect(screen.getByText('ep_ada')).toBeInTheDocument();
  });

  it('previews the latest reply under the root and opens the thread on click', async () => {
    const onReply = vi.fn();
    render(
      <ul>
        <RowView
          row={row('Ada')}
          sender={null}
          replies={2}
          latestReply={replyItem({ display: 'Chief', text: 'pong from chief' })}
          onReply={onReply}
        />
      </ul>,
    );
    expect(screen.getByText('Chief')).toBeInTheDocument();
    expect(screen.getByText('pong from chief')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 replies' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Chief/ }));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('falls back to endpoint id in the preview when display_name is absent', () => {
    render(
      <ul>
        <RowView row={row('Ada')} sender={null} replies={1} latestReply={replyItem()} onReply={() => {}} />
      </ul>,
    );
    expect(screen.getByText('ep_chief')).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
  });

  it('truncates a long reply preview', () => {
    const long = 'x'.repeat(140);
    render(
      <ul>
        <RowView row={row('Ada')} sender={null} replies={1} latestReply={replyItem({ text: long })} onReply={() => {}} />
      </ul>,
    );
    const preview = screen.getByText(/…$/);
    expect(preview.textContent?.length).toBeLessThanOrEqual(120);
  });
});
