-- sigil/migrations/015_rename_login_jti_replays.sql
-- Shared jti-replay guard for both POST /v1/auth/mock-login and the
-- production POST /v1/auth/login (docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md).
-- jti collision across the two routes' tokens is a non-issue in practice
-- (different issuers mint them); one table avoids two near-identical
-- repository methods.
ALTER TABLE mock_login_replays RENAME TO login_jti_replays;
