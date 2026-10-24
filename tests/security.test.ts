import { describe, expect, it } from 'vitest';
import {
  decryptString,
  encryptString,
  isAllowedRedirectUri,
  pkceS256Challenge,
  signValue,
  verifyPkce,
  verifySignedValue,
  assertSecret,
  MissingSecretError,
  DEFAULT_ALLOWED_REDIRECT_URIS,
} from '../src/workers/security.js';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';

describe('signed state', () => {
  it('round-trips a value', async () => {
    const signed = await signValue(SECRET, 'nonce123');
    expect(await verifySignedValue(SECRET, signed)).toBe('nonce123');
  });

  it('rejects a tampered value or signature', async () => {
    const signed = await signValue(SECRET, 'nonce123');
    const [value, sig] = [signed.slice(0, signed.lastIndexOf('.')), signed.slice(signed.lastIndexOf('.') + 1)];
    expect(await verifySignedValue(SECRET, `${value}x.${sig}`)).toBeNull();
    expect(await verifySignedValue(SECRET, `${value}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(await verifySignedValue(SECRET, 'no-signature')).toBeNull();
  });

  it('rejects a value signed with another secret', async () => {
    const signed = await signValue(`${SECRET}-other`, 'nonce123');
    expect(await verifySignedValue(SECRET, signed)).toBeNull();
  });
});

describe('encryption at rest', () => {
  it('round-trips and never stores plaintext', async () => {
    const ct = await encryptString(SECRET, 'harvest-token-abc');
    expect(ct.startsWith('enc:v1:')).toBe(true);
    expect(ct).not.toContain('harvest-token-abc');
    expect(await decryptString(SECRET, ct)).toBe('harvest-token-abc');
  });

  it('uses a fresh IV each time', async () => {
    expect(await encryptString(SECRET, 'x')).not.toBe(await encryptString(SECRET, 'x'));
  });

  it('fails to decrypt with the wrong secret', async () => {
    const ct = await encryptString(SECRET, 'harvest-token-abc');
    await expect(decryptString(`${SECRET}-other`, ct)).rejects.toThrow();
  });

  it('refuses a missing or short secret', () => {
    expect(() => assertSecret(undefined)).toThrow(MissingSecretError);
    expect(() => assertSecret('short')).toThrow(MissingSecretError);
  });
});

describe('PKCE S256', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  it('matches the RFC 7636 appendix B example', async () => {
    expect(await pkceS256Challenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('verifies only the right verifier with S256', async () => {
    const challenge = await pkceS256Challenge(verifier);
    expect(await verifyPkce(verifier, challenge, 'S256')).toBe(true);
    expect(await verifyPkce(`${verifier.slice(0, -1)}A`, challenge, 'S256')).toBe(false);
    expect(await verifyPkce(undefined, challenge, 'S256')).toBe(false);
    expect(await verifyPkce(verifier, verifier, 'plain')).toBe(false);
    expect(await verifyPkce('too-short', challenge, 'S256')).toBe(false);
  });
});

describe('redirect URI policy', () => {
  const uris = DEFAULT_ALLOWED_REDIRECT_URIS;
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'http://localhost:6274/oauth/callback',
    'http://127.0.0.1:33418/callback',
    'http://[::1]:8080/cb',
  ])('allows %s', (uri) => expect(isAllowedRedirectUri(uri, uris)).toBe(true));

  it.each([
    'https://claude.ai/some/other/path',
    'https://claude.ai/api/mcp/auth_callback?next=https://evil.example.com',
    'https://app.claude.ai/callback',
    'https://evil.example.com/callback',
    'https://claude.ai.evil.com/api/mcp/auth_callback',
    'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback#frag',
    'https://user:pw@claude.ai/api/mcp/auth_callback',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (uri) => expect(isAllowedRedirectUri(uri, uris)).toBe(false));
});
