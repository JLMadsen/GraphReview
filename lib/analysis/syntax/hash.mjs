// The text fingerprint shared by the extractors (./extract.mjs, ./routes.mjs,
// the Kotlin reader). Its own module so they can share it without importing
// each other. Plain JavaScript: it runs inside the parse worker.

/**
 * A short fingerprint of a declaration's whole text, whitespace collapsed:
 * equal when the code is equal. Lets a comparison tell "moved" from "moved
 * and changed" without keeping the text (FNV-1a, 32 bit, hex).
 *
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < flat.length; i++) {
    hash ^= flat.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
