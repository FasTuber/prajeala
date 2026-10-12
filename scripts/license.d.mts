// Types for scripts/license.mjs (imported by tests/license.test.ts).
export function generateKeyPair(): { privateKeyPem: string; publicKeySpkiBase64: string };
export function publicKeyFromPrivate(privateKeyPem: string): string;
export function issueKey(
  privateKeyPem: string,
  details: { to: string; id?: string; at?: string },
): { key: string; payload: { v: 1; id: string; to: string; at: string } };
export function verifyKey(
  key: string,
  publicKeySpkiBase64: string,
): { ok: true; payload: unknown } | { ok: false; reason: string };
