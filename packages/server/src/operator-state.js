import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, fstatSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const OPERATOR_STATE_MS = 600_000;
const memoryKeys = new WeakMap();
const proof = pending => pending && typeof pending.state === 'string' && typeof pending.nonce === 'string' &&
  typeof pending.verifier === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(pending.state) &&
  /^[A-Za-z0-9_-]{43}$/u.test(pending.nonce) && /^[A-Za-z0-9_-]{64,128}$/u.test(pending.verifier);

// Publish a complete key atomically, just like confirmation-hmac.key. A racing
// creator reads the winner's key; restarts must never replace it or loosen 0600.
function hostKey(db) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file) {
    if (!memoryKeys.has(db)) memoryKeys.set(db, randomBytes(32));
    return memoryKeys.get(db);
  }
  const path = join(dirname(file), 'operator-state.key');
  let fd, temporary;
  try {
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      temporary = `${path}.${randomUUID()}.tmp`;
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, randomBytes(32)); fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temporary, path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      unlinkSync(temporary); temporary = undefined;
      fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    const info = fstatSync(fd);
    if (!info.isFile() || info.size !== 32 || (info.mode & 0o777) !== 0o600) throw new Error('Invalid operator state key');
    const key = readFileSync(fd);
    if (key.length !== 32) throw new Error('Invalid operator state key');
    return key;
  } catch { throw new Error('Operator state host secret unavailable'); }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* Unpublished crash residue. */ } }
  }
}

export function createOperatorStateSeal(db) {
  const key = hostKey(db), aad = binding => Buffer.from(`operator-state-v1\0${binding}`);
  return {
    seal(pending, binding, expiresAt) {
      if (!proof(pending) || !Number.isSafeInteger(expiresAt)) throw new TypeError('Invalid operator state');
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(binding));
      const plaintext = JSON.stringify({ state: pending.state, nonce: pending.nonce, verifier: pending.verifier, expiresAt, ...(pending.return === 'admin' ? { return: 'admin' } : {}) });
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    },
    open(token, binding, now) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{80,1024}$/u.test(token)) return null;
      try {
        const bytes = Buffer.from(token, 'base64url');
        // Reject alternate encodings so a replay cannot evade the consumed hash.
        if (bytes[0] !== 1 || bytes.toString('base64url') !== token) return null;
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
        decipher.setAAD(aad(binding)); decipher.setAuthTag(bytes.subarray(13, 29));
        const pending = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
        return proof(pending) && Number.isSafeInteger(pending.expiresAt) && pending.expiresAt > now &&
          pending.expiresAt <= now + OPERATOR_STATE_MS ? pending : null;
      } catch { return null; }
    },
  };
}
