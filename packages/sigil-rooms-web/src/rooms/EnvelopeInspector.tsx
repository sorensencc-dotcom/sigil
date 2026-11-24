import type { HistoryItem } from '../api/types';

const MISSING = 'Not provided by relay';

function decodeUtf8(base64url: string): string | null {
  try {
    const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function EnvelopeInspector({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const signature = item.envelope.signature;
  const text = item.canonical_bytes === null ? null : decodeUtf8(item.canonical_bytes);
  return (
    <section className="envelope-inspector" aria-label="Envelope" data-trust="attested">
      <header className="envelope-inspector-head">
        <p className="trust-label">Relay-attested, not verified in this browser</p>
        <button type="button" className="ghost" aria-label="Close envelope" onClick={onClose}>Close</button>
      </header>
      <dl>
        <dt>Algorithm</dt>
        <dd>{signature?.algorithm ?? MISSING}</dd>
        <dt>Key id</dt>
        <dd>{signature?.key_id ?? MISSING}</dd>
        <dt>Signature</dt>
        <dd>{signature?.value ?? MISSING}</dd>
        <dt>Signed bytes (base64url)</dt>
        <dd>{item.canonical_bytes ?? 'Relay stored no signed bytes for this row'}</dd>
        {text !== null ? (
          <>
            <dt>Signed bytes (UTF-8)</dt>
            <dd><pre>{text}</pre></dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
