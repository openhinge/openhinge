import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}

export function encrypt(plaintext: string, secret: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(secret, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  // salt:iv:tag:ciphertext (all hex)
  return [
    salt.toString('hex'),
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted,
  ].join(':');
}

export function decrypt(encoded: string, secret: string): string {
  const [saltHex, ivHex, tagHex, ciphertext] = encoded.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const key = deriveKey(secret, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function generateApiKey(): { key: string; prefix: string } {
  const raw = randomBytes(32).toString('base64url');
  const key = `ohk_${raw}`;
  const prefix = key.slice(0, 12);
  return { key, prefix };
}

export function hashApiKey(key: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(key, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyApiKey(key: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(key, salt, 64);
  return timingSafeEqual(actual, expected);
}

export function generateId(length = 16): string {
  return randomBytes(length).toString('hex').slice(0, length);
}
