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
          <dd>Open a row's envelope to check its signature in this browser. A match with a key you pinned proves who signed. A match with a key the relay served proves only that the stored bytes are intact, because a compromised relay could serve a key of its own.</dd>
        </div>
      </dl>
    </section>
  );
}
