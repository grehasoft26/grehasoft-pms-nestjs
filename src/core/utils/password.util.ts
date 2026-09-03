import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

export class PasswordUtil {
  /**
   * Hash a plain password using bcrypt (10 rounds)
   */
  static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  /**
   * Verify a password against either bcrypt or Django pbkdf2_sha256 hash
   */
  static async verifyPassword(plainPassword: string, storedHash: string): Promise<boolean> {
    if (!storedHash || !plainPassword) return false;

    // Check if Django pbkdf2_sha256 format: pbkdf2_sha256$iterations$salt$hash
    if (storedHash.startsWith('pbkdf2_sha256$')) {
      const parts = storedHash.split('$');
      if (parts.length === 4) {
        const iterations = parseInt(parts[1], 10);
        const salt = parts[2];
        const expectedHash = parts[3];

        const derivedKey = crypto.pbkdf2Sync(
          plainPassword,
          salt,
          iterations,
          32,
          'sha256',
        );
        const derivedHashBase64 = derivedKey.toString('base64');
        return derivedHashBase64 === expectedHash;
      }
    }

    // Standard bcrypt verification
    try {
      return await bcrypt.compare(plainPassword, storedHash);
    } catch {
      return false;
    }
  }
}
