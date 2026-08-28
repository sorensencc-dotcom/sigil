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

For a host without reliable process-completion re-arming, use `--loop`:

```text
sigil inbox --wait --loop --identity <identity> --relay-url <relay> --stream-url <stream>
```

This keeps re-arming after timeout, but does not provide one process-exit
notification per message. Use one-shot `--wait` when host notifications are
available; use `--loop` when continuous inbox presence matters more.

This is an adapter convention. Relay protocol behavior does not depend on a
host noticing process completion. The local `sigil relay up` command uses an
in-memory repository; messages and acknowledgements disappear when that
process exits. Use the PostgreSQL relay for restart durability.

Canonical local checkout for this repository is `C:\dev\sigil-repo`. Start the
relay and run CLI commands from that checkout so the registered `.sigil`
identities and development files remain aligned.

## Host-specific adapters

Each adapter launches one bounded `sigil inbox --wait` process. On exit code
0, consume the notification and launch the next wait. Codes 2, 130, and 143
are safe re-arm conditions; codes 3–5 stop the adapter and surface repair
details.

### Windows PowerShell

```powershell
while ($true) {
  & sigil inbox --wait --identity $env:SIGIL_IDENTITY --relay-url $env:SIGIL_RELAY_URL --stream-url $env:SIGIL_STREAM_URL
  $code = $LASTEXITCODE
  if ($code -in 0, 2, 130, 143) { continue }
  throw "Sigil inbox wait stopped with exit code $code"
}
```

Register the loop with the host background-task facility. Keep credentials in
environment variables rather than command-line history.

### macOS or Linux shell

```sh
while :; do
  sigil inbox --wait --identity "$SIGIL_IDENTITY" \
    --relay-url "$SIGIL_RELAY_URL" --stream-url "$SIGIL_STREAM_URL"
  status=$?
  case "$status" in
    0|2|130|143) ;;
    *) exit "$status" ;;
  esac
done
```

Run this adapter under a launchd agent or systemd user service. The loop
re-arms after each notification; the service manager handles adapter crashes.

### Host callback pseudocode

```text
arm_wait():
  start_background("sigil inbox --wait ...", on_exit=handle_wait_exit)

handle_wait_exit(status, stdout, stderr):
  if status == 0:
    notify_host(stdout)
    arm_wait()
  else if status in {2, 130, 143}:
    arm_wait()
  else:
    notify_host_for_repair(stderr)
```

Process the notification before calling `arm_wait` to preserve one host
notification per delivery and prevent concurrent waits from racing.
