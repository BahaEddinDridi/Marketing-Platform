import * as crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'my-super-secret-key-32chars';
const IV_LENGTH = 16;

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(encrypted: string): string {
  const [ivHex, encryptedText] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedBuffer = Buffer.from(encryptedText, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  return decrypted.toString();
}
