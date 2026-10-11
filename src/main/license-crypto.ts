/**
 * Ed25519 signature verification for signed licence keys (node:crypto, main
 * process only). The public key travels as 32 raw bytes (hex); Node wants a
 * SubjectPublicKeyInfo DER, so the fixed 12-byte prefix is prepended.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { SignatureVerifier } from '../shared/license';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410). */
export const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromHex(hex: string): KeyObject | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** Builds the verifier the shared evaluator expects. `null` key → signed keys unsupported. */
export function makeVerifier(publicKeyHex: string): SignatureVerifier {
  const key = publicKeyFromHex(publicKeyHex);
  if (!key) return () => null;
  return (message, signature) => {
    try {
      return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
    } catch {
      return false;
    }
  };
}
