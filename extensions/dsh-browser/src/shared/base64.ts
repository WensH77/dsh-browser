/**
 * Byte ↔ base64 conversion for code that runs in a browser, not in Node.
 *
 * The service worker is a browser worker: `Buffer` does not exist there. A body
 * encoder that reached for it threw a `ReferenceError` inside a bare `catch`,
 * which left every mocked response paused forever instead of answered — the page
 * waited on a request nobody would ever release.
 *
 * @module
 */

/** Base64 of one byte array, chunked so a large body cannot blow the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary)
}

/** Bytes of one base64 string. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  return bytes
}
