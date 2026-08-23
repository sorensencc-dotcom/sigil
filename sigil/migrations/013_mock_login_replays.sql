-- sigil/migrations/013_mock_login_replays.sql
-- jti-based replay guard for POST /v1/auth/mock-login (mock-OIDC login,
-- docs/superpowers/specs/2026-08-22-sigil-mock-oidc-login.md). The same
-- valid token must not be replayable into unlimited short-lived sessions
-- before it expires; the primary-key uniqueness constraint below makes a
-- second insert of the same jti fail, which the route maps to
-- 401 TOKEN_REPLAYED.

CREATE TABLE IF NOT EXISTS mock_login_replays (
  jti TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS mock_login_replays_expires_at_idx ON mock_login_replays(expires_at);
