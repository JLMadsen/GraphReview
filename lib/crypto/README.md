# lib/crypto

> `lib/crypto/` credential encrypt/decrypt helpers (§11)

From DESIGN.md §11:

> **Credential fields are encrypted at rest.** The PAT and AI API key on
> the `Settings` node (§7) are encrypted with AES-256-GCM, keyed by
> `SESSION_SECRET` (already an env var, §12), before being written to
> Neo4j, and decrypted only in-process when making an API call. This stops
> a plaintext DB dump or backup from being an instant credential leak,
> without building out per-user key management that decision #6 makes
> moot.

## Scope

- `encrypt(plaintext, key)` / `decrypt(ciphertext, key)` using
  AES-256-GCM, keyed off the `SESSION_SECRET` env var.
- Used only by `lib/github/` (PAT) and `lib/ai/` (API key) when reading
  from or writing to the `Settings` node in `lib/neo4j/`.
- Explicitly out of scope (per §11): a full secrets manager/vault
  integration, or per-user key management.
