-- sigil/migrations/014_oidc_issuer_client_id.sql
-- Real OIDC login (docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md)
-- validates a token's aud/azp claim against the OAuth client_id Sigil was
-- registered under at each allow-listed issuer. Required (not nullable):
-- an issuer can't be used for real login until an admin provisions this.
ALTER TABLE oidc_issuer_allowlist ADD COLUMN client_id TEXT;
