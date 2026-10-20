# Reply ingress verification notes

## Cookie listener reply route

The characterization test in `sigil/relay/v1/oauth/public-listener.reply-route.test.mjs` passed. `matchPublicRoute('POST', '/v1/rooms/room_x/replies')` returns `rooms`, `createPublicListener` calls `authenticateCookie`, and a bearer-only request without a cookie receives `401 UNAUTHENTICATED` without reaching the room handler. This matches `sigil/relay/v1/oauth/public-listener.mjs` lines 10-14, 36-44, and 48-57.

## Quota kinds

`SIGIL_TEST_DATABASE_URL` is unset in this worktree, so the live PostgreSQL constraint query was not run. The current migration source lists these kinds in `sigil/migrations/034_oauth_login.sql` lines 54-60.

`endpoint`, `owner`, `conversation`, `directory_invite_create`, `directory_invite_redeem`, `directory_match_create`, `directory_match_attempt`, `federation_origin`, `federation_directory_invite_create`, `federation_directory_redeem`, `federation_directory_redemption_inbound`, `invite`, `oauth_provider_subject`, `oauth_start`.

Task 2 adds `floor_warden_reply` while preserving every kind above. Live constraint confirmation remains unavailable until a disposable `_test` database is supplied.

## Migration folder and number

The highest existing migration is `036_report_only_mode.sql`. No `037_*.sql` or `038_*.sql` file is present, and migration 036 does not touch `quota_usage`. Task 2 uses migration `039_reply_ingress.sql` because the plan reserves 036 through 038 and requires numbering no lower than 039 while those reservations remain unmerged. This follows the renumbering rule without reusing 035 through 038.

## Reply route and rate-limit convention

The inline reply gate in `sigil/relay/v1/http-server.mjs` lines 253-287 handles bearer extraction, token matching, endpoint-principal distinction, missing handler, room-path decoding, thrown-handler errors, and response serialization. `sigil/relay/v1/floor-warden-replies.mjs` lines 47-140 handles body parsing and the reply checks, including the current over-cap response `400 INVALID_REQUEST`. Its wrapper at lines 142-160 records `room.floor_warden_reply` audit outcomes. The accept path maps `RATE_LIMITED` to `429` in `sigil/relay/v1/accept-envelope.mjs` lines 18-46 and emits `{request_id, code, message, details}` in `toResponse` at lines 119-131.

The repository sets lowercase `retry-after: '60'` on two existing `429 RATE_LIMITED` responses in `sigil/relay/v1/http-server.mjs` lines 181-184 and 444-446. The value follows the HTTP convention of seconds. Task 8 should use the same 60-second unit for minute-window ingress limits.

## Port and bridge notes

The operational plan values are relay `8791`, stream `8792`, cookie-only public `8793`, and reply ingress `8796`. The CLI source defaults `--port` and `--stream-port` to `0` and `port + 1` when an explicit port is supplied (`sigil/cli/sigil.mjs` lines 217-219), while the client default relay URL is `http://127.0.0.1:8791` (`sigil/cli/config-resolver.mjs` line 7). The public listener uses `resolvePublicPort({ port, publicPort })` (`sigil/cli/sigil.mjs` lines 369-415). The 8793 overlap with the mesh skill's stream port remains a flag only. The reply ingress uses port plus 5.

`BRIDGES` is derived from `CLI_KINDS` plus `router` in `sigil/relay/v1/transport-tincan/wake-dispatcher.mjs` lines 1-3. It has no `floor-warden` entry, and Task 1-3 add none.
