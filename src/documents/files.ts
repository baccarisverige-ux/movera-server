import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Document files at rest (contract v0.5.3 §14): every upload is encrypted with AES-256-GCM under the server's
 * documents key before it is stored, and decrypted only for the file endpoints. The key comes from
 * DOCUMENT_FILES_KEY (base64, 32 bytes); outside production a key derived from JWT_SECRET stands in, so a laptop
 * and the test suite need no extra setting. key_id names the key a file was sealed with, for a later rotation.
 */
export type DocumentKey = { keyId: string; key: Buffer };

export function documentKeyFrom(env: { DOCUMENT_FILES_KEY?: string | undefined; MOVERA_ENV: string }, jwtSecret: string): DocumentKey {
  if (env.DOCUMENT_FILES_KEY !== undefined) {
    const key = Buffer.from(env.DOCUMENT_FILES_KEY, "base64");
    if (key.length !== 32) throw new Error("DOCUMENT_FILES_KEY must be 32 bytes, base64");
    return { keyId: `k-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`, key };
  }
  if (env.MOVERA_ENV === "production") throw new Error("DOCUMENT_FILES_KEY is required in production");
  return { keyId: "derived-jwt", key: createHash("sha256").update(`movera-documents:${jwtSecret}`).digest() };
}

export function sealFile(key: DocumentKey, plain: Buffer): { key_id: string; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { key_id: key.keyId, iv, tag: cipher.getAuthTag(), ciphertext };
}

export function openFile(key: DocumentKey, sealed: { key_id: string; iv: Buffer; tag: Buffer; ciphertext: Buffer }): Buffer {
  if (sealed.key_id !== key.keyId) throw new Error(`This file was sealed with another key (${sealed.key_id})`);
  const decipher = createDecipheriv("aes-256-gcm", key.key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}
