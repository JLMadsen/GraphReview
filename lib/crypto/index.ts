// lib/crypto — credential encrypt/decrypt helpers.
//
// AES-256-GCM, keyed by the `SESSION_SECRET` env var. `SESSION_SECRET` is an
// arbitrary user-supplied string (see docker/.env.example),
// not guaranteed to be 32 bytes, so it is never used as the AES key
// directly. Instead it is stretched into a 256-bit key with `scryptSync`
// (a deliberately slow KDF — appropriate here since the key is derived once
// per process and cached, not per call) using a static, app-specific salt.
// The salt only needs to be constant and non-empty (it defends against
// precomputed rainbow tables for the KDF step); it does not need to be
// secret or random, because per-encryption uniqueness already comes from a
// fresh random IV on every `encrypt()` call, and the key itself is only
// ever used in-process, never persisted.
//
// Output format (`encrypt`'s return value): base64( iv[12] || authTag[16] || ciphertext ).
// Self-contained and versionless — `decrypt` slices it back apart using the
// fixed 12/16-byte header lengths, so no separate storage of iv/tag is
// needed by callers (e.g. the `Settings` node).
//
// This module has no Neo4j or GitHub dependency — it is pure crypto over
// strings, used by callers (e.g. app/settings' server action, lib/github,
// lib/ai) that read/write the `Settings` node.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits — recommended IV size for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
// Static, app-specific KDF salt — see module comment above for why this is
// safe to hardcode rather than randomize or read from env.
const KDF_SALT = "graphreview.lib-crypto.v1";

let cachedKey: Buffer | undefined;
let cachedSecret: string | undefined;

/**
 * Derives (and caches) the 256-bit AES key from `SESSION_SECRET`.
 * Throws a clear error if `SESSION_SECRET` is missing or empty rather than
 * silently falling back to a weak/default key.
 */
function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "lib/crypto: SESSION_SECRET env var is not set. A real secret is " +
        "required to encrypt/decrypt credential fields " +
        "— refusing to fall back to a weak or default key."
    );
  }

  // Re-derive only if the secret changes (e.g. across tests); otherwise
  // reuse the cached key to avoid paying the scrypt cost on every call.
  if (!cachedKey || cachedSecret !== secret) {
    cachedKey = scryptSync(secret, KDF_SALT, KEY_LENGTH);
    cachedSecret = secret;
  }
  return cachedKey;
}

/**
 * Encrypts `plaintext` with AES-256-GCM, keyed by `SESSION_SECRET`.
 * Returns a self-contained base64 blob: iv (12 bytes) + authTag (16 bytes) +
 * ciphertext. Safe to persist directly (e.g. as a `Settings` property).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypts a blob produced by `encrypt()`. Throws if `blob` is malformed or
 * fails authentication (wrong key, or the ciphertext was tampered with).
 */
export function decrypt(blob: string): string {
  const key = getKey();
  const raw = Buffer.from(blob, "base64");

  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("lib/crypto: malformed ciphertext blob (too short).");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
