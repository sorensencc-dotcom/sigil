import type { HistoryItem } from '../api/types';
import type { Verification } from './useVerification';

const MISSING = 'Not provided by relay';

function decodeUtf8(base64url: string): string | null {
  try {
    const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

// What the browser may claim for each outcome. Only a check this browser computed reaches a verified state.
function describe(verification: Verification | undefined): { trust: string; label: string; detail?: string } {
  const result = verification?.result;
  if (!result) return { trust: 'attested', label: 'Relay-attested, not verified in this browser' };
  switch (result.state) {
    case 'pinned': return { trust: 'verified', label: 'Matches your pinned key', detail: `Key ${result.keyId}` };
    case 'relay': return { trust: 'relay-key', label: "Matches the relay's key", detail: `Key ${result.keyId}. This proves the stored bytes are intact, not who sent them: the relay supplied the key.` };
    case 'failed': return { trust: 'failed', label: 'Signature check failed', detail: result.reason };
    case 'unsupported': return { trust: 'unsupported', label: "Can't verify in this browser", detail: 'This browser does not support Ed25519 in WebCrypto.' };
    default: return { trust: 'attested', label: 'Relay-attested, not verified in this browser', detail: result.reason };
  }
}

export function EnvelopeInspector({ item, onClose, verification }: { item: HistoryItem; onClose: () => void; verification?: Verification }) {
  const trust = describe(verification);
  const signature = item.envelope.signature;
  const text = item.canonical_bytes === null ? null : decodeUtf8(item.canonical_bytes);
  return (
    <section className="envelope-inspector" aria-label="Envelope" data-trust={trust.trust}>
      <header className="envelope-inspector-head">
        <p className="trust-label">{trust.label}</p>
        <button type="button" className="ghost" aria-label="Close envelope" onClick={onClose}>Close</button>
      </header>
      {trust.detail ? <p className="trust-detail">{trust.detail}</p> : null}
      {verification?.pinned ? (
        <button type="button" className="ghost" onClick={verification.unpin}>Unpin key</button>
      ) : verification?.result?.state === 'relay' ? (
        <button type="button" className="ghost" onClick={verification.pin}>Pin this key</button>
      ) : null}
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
