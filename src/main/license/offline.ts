/**
 * Offline licence keys: `PRJ1-<base64url(JSON payload)>.<base64url(Ed25519 signature)>`.
 *
 * The signature covers the ASCII text before the dot (prefix included), so a
 * key can neither be edited nor re-labelled for another format version. Keys
 * are issued by `scripts/license.mjs` with the author's private key; the app
 * only ever holds the public key (src/shared/product.ts).
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { OFFLINE_KEY_PREFIX, cleanKey, parseOfflinePayload, type OfflineLicensePayload } from '../../shared/license';

export type OfflineVerification =
  | { ok: true; payload: OfflineLicensePayload }
  | { ok: false; code: 'not-configured' | 'malformed' | 'invalid'; message: string };

const publicKeyCache = new Map<string, KeyObject | null>();

function loadPublicKey(spkiBase64: string): KeyObject | null {
  if (publicKeyCache.has(spkiBase64)) return publicKeyCache.get(spkiBase64) ?? null;
  const key = parsePublicKey(spkiBase64);
  publicKeyCache.set(spkiBase64, key);
  return key;
}

function parsePublicKey(spkiBase64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function signatureMatches(signed: string, signature: Buffer, publicKey: KeyObject): boolean {
  try {
    return signature.length === 64 && verify(null, Buffer.from(signed, 'ascii'), publicKey, signature);
  } catch {
    return false;
  }
}

function decodePayload(encoded: string): unknown {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function verifyOfflineKey(
  input: string,
  publicKeySpkiBase64: string,
  revokedIds: readonly string[] = [],
): OfflineVerification {
  if (!publicKeySpkiBase64) {
    return { ok: false, code: 'not-configured', message: 'Offline licence keys are not enabled in this build.' };
  }
  const publicKey = loadPublicKey(publicKeySpkiBase64);
  if (!publicKey) return { ok: false, code: 'not-configured', message: 'The offline licence public key of this build is invalid.' };

  const key = cleanKey(input);
  const dot = key.lastIndexOf('.');
  if (!key.startsWith(OFFLINE_KEY_PREFIX) || dot <= OFFLINE_KEY_PREFIX.length || dot === key.length - 1) {
    return { ok: false, code: 'malformed', message: 'This does not look like a Prăjeală licence key.' };
  }
  const signed = key.slice(0, dot);
  const signature = Buffer.from(key.slice(dot + 1), 'base64url');
  if (!signatureMatches(signed, signature, publicKey)) {
    return { ok: false, code: 'invalid', message: 'This licence key is not valid.' };
  }
  const payload = parseOfflinePayload(decodePayload(signed.slice(OFFLINE_KEY_PREFIX.length)));
  if (!payload) return { ok: false, code: 'malformed', message: 'This licence key is damaged.' };
  if (revokedIds.includes(payload.id)) return { ok: false, code: 'invalid', message: 'This licence key has been revoked.' };
  return { ok: true, payload };
}
