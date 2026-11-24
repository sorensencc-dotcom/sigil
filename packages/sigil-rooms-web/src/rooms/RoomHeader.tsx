import { useState } from 'react';
import { RenameTitle } from './RenameTitle';
import { RosterPanel } from './RosterPanel';
import { TrustSummary } from './TrustSummary';
import { isManager } from './roles';
import { useMembers } from './useMembers';

export function RoomHeader({ roomId, name, purpose, maxAgentTurns, sender, onGone }: { roomId: string; name: string; purpose?: string | null; maxAgentTurns?: number; sender: string | null; onGone: () => void }) {
  const members = useMembers(roomId);
  const [openPanel, setOpenPanel] = useState<'roster' | 'trust' | null>(null);
  const manager = isManager(members.data ?? [], sender);
  return (
    <header className="room-header">
      <div className="room-heading">
        <RenameTitle roomId={roomId} name={name} canRename={manager} onGone={onGone} />
        {purpose ? <p className="room-purpose">{purpose}</p> : null}
      </div>
      <div className="room-actions">
        <button type="button" className="ghost" aria-expanded={openPanel === 'roster'} onClick={() => setOpenPanel((open) => open === 'roster' ? null : 'roster')}>Roster</button>
        <button type="button" className="ghost" aria-expanded={openPanel === 'trust'} onClick={() => setOpenPanel((open) => open === 'trust' ? null : 'trust')}>Trust</button>
      </div>
      {openPanel === 'roster' ? <RosterPanel roomId={roomId} maxAgentTurns={maxAgentTurns} members={members.data ?? []} manager={manager} viewer={sender} onGone={onGone} /> : null}
      {openPanel === 'trust' ? <TrustSummary /> : null}
    </header>
  );
}
