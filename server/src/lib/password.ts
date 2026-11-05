import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (built into Node — no native add-on to install on Windows).
 * Stored format: "scrypt$N$r$p$<salt base64>$<hash base64>", so parameters can be raised later
 * without breaking existing hashes. Each password gets its own random 16-byte salt.
 */
const N = 16384; // CPU/memory cost (~50 ms per hash on a normal PC)
const R = 8;
const P = 1;
const KEY_LEN = 64;
export const MAX_PASSWORD_LENGTH = 128; // bounds hashing work per request

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length > MAX_PASSWORD_LENGTH) throw new RangeError('Password too long');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64 || password.length > MAX_PASSWORD_LENGTH) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random password, used when a username doesn't exist so the response takes
 * as long as a wrong password would (no timing hint about which usernames exist).
 */
let dummyHash: Promise<string> | null = null;
export const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(18).toString('base64')));
