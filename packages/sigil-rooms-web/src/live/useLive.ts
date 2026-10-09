import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { LiveSocket } from './socket';

export function useLive(): 'live' | 'off' {
  const { client, streamUrl, token } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'live' | 'off'>('off');

  useEffect(() => {
    if (!token) return;
    const socket = new LiveSocket({
      streamUrl,
      getTicket: async () => (await client.wsTicket()).ticket,
      onFrame: (frame) => {
        if (frame.changed === 'room') {
          void queryClient.invalidateQueries({ queryKey: ['rooms'] });
        } else if (frame.changed === 'members') {
          // A member added to a room the client has not opened still has to show up in the sidebar.
          void queryClient.invalidateQueries({ queryKey: ['rooms'] });
          void queryClient.invalidateQueries({ queryKey: ['room', frame.room_id, 'members'] });
        } else {
          const queryKey = ['room', frame.room_id, 'messages'];
          // Cancel first so an in-flight fetch that predates this frame cannot be reused.
          void queryClient
            .cancelQueries({ queryKey })
            .catch(() => {})
            .then(() => queryClient.invalidateQueries({ queryKey }));
        }
      },
      onStatus: setStatus,
      onReconnect: () => void queryClient.invalidateQueries(),
    });
    socket.start();
    return () => socket.stop();
  }, [client, streamUrl, token, queryClient]);

  useEffect(() => {
    if (status === 'live') return;
    const interval = setInterval(() => void queryClient.invalidateQueries({ refetchType: 'active' }), 30_000);
    return () => clearInterval(interval);
  }, [status, queryClient]);

  return status;
}
