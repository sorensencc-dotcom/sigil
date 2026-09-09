# Grokbot adapter

The Grokbot adapter runs Sigil task workers against xAI’s OpenAI-compatible API. It uses the standard `sigil agent run` daemon and `sigil/scripts/openai-worker.mjs` worker.

## Configure xAI Grok

Set the API key before starting the daemon:

```powershell
$env:GROK_API_KEY = "xai-..."
$env:SIGIL_MODEL = "grok-beta"  # optional; defaults to grok-beta with GROK_API_KEY
sigil agent run --identity .sigil/grokbot.identity.json --relay-url http://127.0.0.1:8791 --worker sigil/scripts/openai-worker.mjs
```

The worker selects `https://api.x.ai/v1` when `GROK_API_KEY` is present. Set `GROK_BASE_URL` to use another xAI-compatible endpoint.

## Environment contract

| Variable | Required | Behavior |
|---|---:|---|
| `GROK_API_KEY` | For Grok | Selects xAI and the `grok-beta` default model. |
| `GROK_BASE_URL` | No | Overrides the xAI-compatible API base URL. |
| `SIGIL_MODEL` | No | Overrides the selected model. |

Without Grok credentials, the same worker accepts `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and defaults to `gpt-4o`.

## Message flow

The daemon receives signed `task.request` envelopes, sends the task body to the configured model endpoint, and returns a signed `task.result` envelope. Sigil still applies endpoint identity, envelope signatures, capability checks, idempotency, and delivery acknowledgements around the model call.

Keep API keys in process environment or a secret manager. Never place credentials in identities, envelopes, logs, or wiki examples.
