import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// ======================================================
// إعدادات Password Hash
//
// نستخدم scrypt الموجود داخل Node.js نفسه.
// لا يتم حفظ كلمة المرور الأصلية مطلقًا.
// ======================================================

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const MAX_MEMORY = 64 * 1024 * 1024

// شكل القيمة داخل قاعدة البيانات:
//
// scrypt$N$r$p$salt$derivedKey
// ======================================================
function derivePasswordKey(
  password: string,
  salt: Buffer,
  options: {
    n: number
    r: number
    p: number
    keyLength: number
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      options.keyLength,
      {
        N: options.n,
        r: options.r,
        p: options.p,
        maxmem: MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error)
          return
        }

        resolve(derivedKey)
      },
    )
  })
}

// ======================================================
// hashPassword
//
// تحول كلمة المرور إلى Hash آمن قبل تخزينها.
// ======================================================
export async function hashPassword(password: string) {
  if (typeof password !== 'string') {
    throw new Error('Password must be a string')
  }

  if (password.length < 8) {
    throw new Error('Password must contain at least 8 characters')
  }

  if (password.length > 128) {
    throw new Error('Password must not exceed 128 characters')
  }

  const salt = randomBytes(16)

  const derivedKey = await derivePasswordKey(password, salt, {
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLength: KEY_LENGTH,
  })

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    derivedKey.toString('hex'),
  ].join('$')
}

// ======================================================
// verifyPassword
//
// تعيد حساب الـ Hash باستخدام نفس الإعدادات
// ثم تقارن النتيجة بطريقة timing-safe.
// ======================================================
export async function verifyPassword(password: string, storedHash: string) {
  try {
    const parts = storedHash.split('$')

    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false
    }

    const n = Number(parts[1])
    const r = Number(parts[2])
    const p = Number(parts[3])

    const salt = Buffer.from(parts[4], 'hex')
    const expectedKey = Buffer.from(parts[5], 'hex')

    if (
      !Number.isInteger(n) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      n <= 0 ||
      r <= 0 ||
      p <= 0 ||
      salt.length === 0 ||
      expectedKey.length === 0
    ) {
      return false
    }

    const actualKey = await derivePasswordKey(password, salt, {
      n,
      r,
      p,
      keyLength: expectedKey.length,
    })

    if (actualKey.length !== expectedKey.length) {
      return false
    }

    return timingSafeEqual(actualKey, expectedKey)
  } catch {
    // أي Hash قديم أو غير صالح يتم رفضه بدون إسقاط الـ API.
    return false
  }
}
