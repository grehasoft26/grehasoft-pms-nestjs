import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly secretKey: Buffer;
  private readonly algorithm = 'aes-256-cbc';

  constructor(private readonly configService: ConfigService) {
    const rawSecret = this.configService.get<string>('SECRET_KEY') || 'django-insecure-grehasoft-dev-key';
    // Hash key to 32 bytes for AES-256
    this.secretKey = crypto.createHash('sha256').update(rawSecret).digest();
  }

  /**
   * Encrypt plain text using AES-256-CBC
   */
  encrypt(text: string): string {
    if (!text) return text;
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.secretKey, iv);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return `${iv.toString('hex')}:${encrypted}`;
    } catch (error) {
      console.error('Encryption error:', error);
      return text;
    }
  }

  /**
   * Decrypt encrypted text using AES-256-CBC
   */
  decrypt(cipherText: string): string {
    if (!cipherText) return cipherText;
    try {
      if (!cipherText.includes(':')) {
        // Return raw text if not formatted as iv:encrypted or Fernet string fallback
        return cipherText;
      }
      const [ivHex, encryptedHex] = cipherText.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv(this.algorithm, this.secretKey, iv);
      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      // Fail gracefully returning original value if token invalid or unencrypted
      return cipherText;
    }
  }
}
