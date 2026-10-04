# lib/crypto

> `lib/crypto/` credential encrypt/decrypt helpers

From the project's background on credential storage:

> **Credential fields are encrypted at rest.** The PATs and AI API keys in
> the stored settings are encrypted with AES-256-GCM before being written to
> the database, and decrypted only in-process when making an API call. This stops
> a plaintext DB dump or backup from being an instant credential leak,
> without building out per-user key management that the single-instance
> deployment model makes moot.

## Scope

- `encrypt(plaintext)` / `decrypt(ciphertext)` using AES-256-GCM, keyed
  off the `SESSION_SECRET` env var when set, otherwise a random secret
  generated on first use and kept in `secret.key` in the data folder
  (`~/.graphreview` by default). Anyone who can read that folder can read
  the database too, so this protects copies of the database file on their
  own (backups, a shared bug report), not the folder as a whole.
- Used by callers that read or write credentials in the stored settings
  (`lib/db/settings.ts`, `lib/db/ai-provider.ts`).
- Explicitly out of scope: a full secrets manager/vault
  integration, or per-user key management.
