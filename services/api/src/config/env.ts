import dotenv from 'dotenv'

dotenv.config()

const apiPort = Number(process.env.API_PORT || 3000)

const databaseUrl = process.env.DATABASE_URL || ''

// مدة جلسة تسجيل الدخول بالساعات.
// القيمة الافتراضية 12 ساعة.
const authSessionHours = Number(process.env.AUTH_SESSION_HOURS || 12)

if (!databaseUrl) {
  throw new Error('DATABASE_URL is missing in .env')
}

if (!Number.isFinite(apiPort) || apiPort <= 0) {
  throw new Error('API_PORT must be a valid positive number')
}

if (
  !Number.isFinite(authSessionHours) ||
  authSessionHours <= 0 ||
  authSessionHours > 720
) {
  throw new Error('AUTH_SESSION_HOURS must be between 1 and 720')
}

export const env = {
  apiPort,
  databaseUrl,
  authSessionHours,
}
