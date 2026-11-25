import type { HistoryItem } from '../api/types';
import { EnvelopeInspector } from './EnvelopeInspector';
import { useVerification } from './useVerification';

export function VerifiedEnvelopeInspector({ roomId, item, onClose }: { roomId: string; item: HistoryItem; onClose: () => void }) {
  return <EnvelopeInspector item={item} onClose={onClose} verification={useVerification(roomId, item)} />;
}
