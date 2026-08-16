# Host convention: Sigil inbox wait

Host adapters that support background-task completion should keep one one-shot
wait armed after each completed turn:

```text
sigil inbox --wait --identity <identity> --relay-url <relay> --stream-url <stream>
```

When the process exits successfully, surface its stdout to the active host
session, act on exactly that one message, then arm the next wait. Exit code 2
means no message arrived before timeout and may be re-armed. Exit codes 3–5
mean authentication, connection, or malformed-delivery failure and should be
shown for repair rather than silently retried. Exit codes 130/143 mean the
process was interrupted (SIGINT/SIGTERM) mid-wait -- nothing was acknowledged,
safe to re-arm.

This is an adapter convention. Relay protocol behavior does not depend on a
host noticing process completion. The local `sigil relay up` command uses an
in-memory repository; messages and acknowledgements disappear when that
process exits. Use the PostgreSQL relay for restart durability.

Canonical local checkout for this repository is `C:\dev\sigil-repo`. Start the
relay and run CLI commands from that checkout so the registered `.sigil`
identities and development files remain aligned.
