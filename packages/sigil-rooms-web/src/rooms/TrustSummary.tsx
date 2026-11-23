export function TrustSummary() {
  return (
    <section className="trust-summary" aria-label="Room trust summary">
      <h2>Room trust summary</h2>
      <dl>
        <div>
          <dt>What is signed</dt>
          <dd>The signature covers the canonical envelope, including its message body and sender identity. Human signatures may use a relay-custodial key.</dd>
        </div>
        <div>
          <dt>What the relay can see</dt>
          <dd>Message text, sender and owner IDs, room membership, timestamps, and routing metadata. Room messages are signed, not end-to-end encrypted.</dd>
        </div>
        <div>
          <dt>What this browser verified</dt>
          <dd>Not yet verified. This browser has not checked signatures against a pinned key. A key supplied by the relay alone cannot protect against a compromised relay.</dd>
        </div>
      </dl>
    </section>
  );
}
