/**
 * Security primitives for the Workers OAuth layer.
 *
 * Everything here uses WebCrypto (crypto.subtle), which is available in
 * Cloudflare Workers and in Node 18+ (used by the test suite).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Cryptographically random, URL-safe token (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (both inputs are short, non-secret-length tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Secret handling
// ---------------------------------------------------------------------------

export class MissingSecretError extends Error {
  constructor() {
    super('SESSION_SECRET is not configured (set it with `wrangler secret put SESSION_SECRET`).');
    this.name = 'MissingSecretError';
  }
}

/** Minimum secret length we accept; a 32-byte random value base64-encodes to 43+ chars. */
const MIN_SECRET_LENGTH = 32;

export function assertSecret(secret: string | undefined): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new MissingSecretError();
  return secret;
}

async function deriveKey(secret: string, purpose: string, usage: 'hmac' | 'aes') {
  // Domain-separate keys per purpose: SHA-256(secret || purpose) as raw key material.
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`${purpose}\u0000${secret}`));
  if (usage === 'hmac') {
    return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ---------------------------------------------------------------------------
// HMAC-signed values (OAuth state)
// ---------------------------------------------------------------------------

export async function signValue(secret: string, value: string): Promise<string> {
  const key = await deriveKey(assertSecret(secret), 'oauth-state-v1', 'hmac');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return `${value}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Returns the original value if the signature is valid, otherwise null. */
export async function verifySignedValue(secret: string, signed: string): Promise<string | null> {
  const idx = signed.lastIndexOf('.');
  if (idx <= 0) return null;
  const value = signed.slice(0, idx);
  let sig: Uint8Array;
  try {
    sig = base64UrlDecode(signed.slice(idx + 1));
  } catch {
    return null;
  }
  const key = await deriveKey(assertSecret(secret), 'oauth-state-v1', 'hmac');
  const ok = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(value));
  return ok ? value : null;
}

// ---------------------------------------------------------------------------
// AES-GCM encryption (tokens at rest in KV)
// ---------------------------------------------------------------------------

const ENC_PREFIX = 'enc:v1:';

/**
 * Encrypt with AES-GCM. `aad` (e.g., the session ID) binds the ciphertext to
 * its record so it cannot be moved into another record and still decrypt.
 */
export async function encryptString(secret: string, plaintext: string, aad = ''): Promise<string> {
  const key = await deriveKey(assertSecret(secret), 'kv-token-encryption-v1', 'aes');
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext)
  );
  return `${ENC_PREFIX}${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptString(secret: string, value: string, aad = ''): Promise<string> {
  if (!value.startsWith(ENC_PREFIX)) {
    throw new Error('Value is not encrypted with the expected scheme');
  }
  const [ivPart, ctPart] = value.slice(ENC_PREFIX.length).split('.');
  if (!ivPart || !ctPart) throw new Error('Malformed encrypted value');
  const key = await deriveKey(assertSecret(secret), 'kv-token-encryption-v1', 'aes');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(ivPart), additionalData: encoder.encode(aad) },
    key,
    base64UrlDecode(ctPart)
  );
  return decoder.decode(pt);
}

export function isEncrypted(value: string | undefined): boolean {
  return !!value && value.startsWith(ENC_PREFIX);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export async function pkceS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function verifyPkce(
  verifier: string | undefined,
  challenge: string,
  method: string
): Promise<boolean> {
  if (method !== 'S256') return false;
  if (!verifier || !PKCE_VERIFIER_RE.test(verifier)) return false;
  const computed = await pkceS256Challenge(verifier);
  return timingSafeEqual(computed, challenge);
}

// ---------------------------------------------------------------------------
// Redirect URI policy
// ---------------------------------------------------------------------------

/** Exact redirect URIs used by Claude's hosted connectors. */
export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A redirect URI is acceptable if it is:
 *  - an exact match for one of the allowlisted URIs (query strings included), or
 *  - http(s) on a loopback host, any port and path (native/desktop clients,
 *    RFC 8252 §7.3). Only software on the user's own machine can receive these.
 * Fragments and embedded credentials are never allowed.
 */
export function isAllowedRedirectUri(uri: string, allowedUris: string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || uri.includes('#')) return false;
  if (url.username || url.password) return false;

  if (LOOPBACK_HOSTS.has(url.hostname)) {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }
  return allowedUris.includes(uri);
}

export function parseAllowedRedirectUris(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_ALLOWED_REDIRECT_URIS;
  const uris = raw.split(',').map((u) => u.trim()).filter(Boolean);
  return uris.length ? uris : DEFAULT_ALLOWED_REDIRECT_URIS;
}

export function parseIdList(raw: string | undefined): string[] {
  return (raw || '').split(',').map((v) => v.trim()).filter(Boolean);
}
