import { createHash, randomBytes } from 'node:crypto'
import { Router } from 'express'
import { db } from '../../db/pool'

export const posDevicesRouter = Router()

class PosDeviceApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const allowedDeviceStatuses = new Set(['active', 'inactive', 'blocked'])

function isUuid(value: string) {
  return uuidPattern.test(value)
}

function createDeviceSecret() {
  return randomBytes(32).toString('hex')
}

function hashDeviceSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex')
}

function createDeviceCode() {
  return `POS-${randomBytes(4).toString('hex').toUpperCase()}`
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

// ======================================================
// GET /api/pos-devices/branches
//
// الفروع المتاحة لربط جهاز POS.
// ======================================================
posDevicesRouter.get('/api/pos-devices/branches', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    const authenticatedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const result = await db.query(
      `
        SELECT
          id,
          code,
          name,
          is_active
        FROM branches
        WHERE company_id = $1
          AND is_active = TRUE
          AND (
            $2::uuid IS NULL
            OR id = $2::uuid
          )
        ORDER BY name ASC;
        `,
      [companyId.trim(), authenticatedBranchId],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/pos-devices
// ======================================================
posDevicesRouter.get('/api/pos-devices', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId
    const status = req.query.status

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    const authenticatedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const selectedStatus =
      typeof status === 'string' && status.trim() ? status.trim() : null

    if (selectedStatus && !allowedDeviceStatuses.has(selectedStatus)) {
      return res.status(400).json({
        error: 'Unsupported POS device status',
      })
    }

    const result = await db.query(
      `
        SELECT
          pd.id,
          pd.company_id,
          pd.branch_id,

          b.name AS branch_name,
          b.code AS branch_code,

          pd.device_code,
          pd.device_name,
          pd.status,

          pd.last_seen_at,
          pd.registered_at,
          pd.secret_rotated_at,
          pd.updated_at,

          u.full_name AS created_by_name,

          CASE
            WHEN pd.device_secret_hash IS NULL
            THEN FALSE
            ELSE TRUE
          END AS has_secret

        FROM pos_devices pd

        JOIN branches b
          ON b.id = pd.branch_id
          AND b.company_id = pd.company_id

        LEFT JOIN users u
          ON u.id = pd.created_by

        WHERE pd.company_id = $1

          AND (
            $2::uuid IS NULL
            OR pd.branch_id = $2::uuid
          )

          AND (
            $3::text IS NULL
            OR pd.status = $3::text
          )

        ORDER BY
          b.name ASC,
          pd.device_name ASC;
        `,
      [companyId.trim(), authenticatedBranchId, selectedStatus],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// POST /api/pos-devices
//
// تسجيل جهاز جديد وإظهار المفتاح الخام مرة واحدة فقط.
// ======================================================
posDevicesRouter.post('/api/pos-devices', async (req, res, next) => {
  try {
    const { companyId, branchId, deviceCode, deviceName, createdBy } = req.body

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId is required',
      })
    }

    if (typeof branchId !== 'string' || !isUuid(branchId.trim())) {
      return res.status(400).json({
        error: 'branchId is required and must be valid',
      })
    }

    if (typeof deviceName !== 'string' || !deviceName.trim()) {
      return res.status(400).json({
        error: 'deviceName is required',
      })
    }

    const selectedDeviceCode =
      typeof deviceCode === 'string' && deviceCode.trim()
        ? deviceCode.trim().toUpperCase()
        : createDeviceCode()

    const branchResult = await db.query(
      `
        SELECT
          id,
          code,
          name
        FROM branches
        WHERE company_id = $1
          AND id = $2
          AND is_active = TRUE
        LIMIT 1;
        `,
      [companyId.trim(), branchId.trim()],
    )

    if ((branchResult.rowCount ?? 0) === 0) {
      throw new PosDeviceApiError(404, 'Branch was not found or inactive')
    }

    const deviceSecret = createDeviceSecret()

    const deviceSecretHash = hashDeviceSecret(deviceSecret)

    const result = await db.query(
      `
        INSERT INTO pos_devices (
          company_id,
          branch_id,
          device_code,
          device_name,
          status,
          device_secret_hash,
          secret_rotated_at,
          created_by,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4,
          'active',
          $5,
          NOW(),
          $6,
          NOW()
        )
        RETURNING
          id,
          company_id,
          branch_id,
          device_code,
          device_name,
          status,
          last_seen_at,
          registered_at,
          secret_rotated_at,
          updated_at;
        `,
      [
        companyId.trim(),
        branchId.trim(),
        selectedDeviceCode,
        deviceName.trim(),
        deviceSecretHash,
        createdBy || null,
      ],
    )

    return res.status(201).json({
      data: {
        device: {
          ...result.rows[0],
          branch_name: branchResult.rows[0].name,
          branch_code: branchResult.rows[0].code,
          has_secret: true,
        },

        // يظهر مرة واحدة فقط.
        deviceSecret,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({
        error: 'كود جهاز POS مستخدم بالفعل داخل الفرع.',
      })
    }

    if (error instanceof PosDeviceApiError) {
      return res.status(error.statusCode).json({
        error: error.message,
      })
    }

    return next(error)
  }
})

// ======================================================
// PATCH /api/pos-devices/:deviceId/status
// ======================================================
posDevicesRouter.patch(
  '/api/pos-devices/:deviceId/status',
  async (req, res, next) => {
    try {
      const deviceId = String(req.params.deviceId || '').trim()

      const { companyId, branchId, status } = req.body

      if (!isUuid(deviceId)) {
        return res.status(400).json({
          error: 'deviceId is invalid',
        })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      if (typeof status !== 'string' || !allowedDeviceStatuses.has(status)) {
        return res.status(400).json({
          error: 'Unsupported POS device status',
        })
      }

      const authenticatedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const result = await db.query(
        `
        UPDATE pos_devices
        SET
          status = $1,
          updated_at = NOW()
        WHERE company_id = $2
          AND id = $3
          AND (
            $4::uuid IS NULL
            OR branch_id = $4::uuid
          )
        RETURNING
          id,
          company_id,
          branch_id,
          device_code,
          device_name,
          status,
          last_seen_at,
          registered_at,
          secret_rotated_at,
          updated_at;
        `,
        [status, companyId.trim(), deviceId, authenticatedBranchId],
      )

      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'POS device was not found',
        })
      }

      return res.json({
        data: result.rows[0],
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// POST /api/pos-devices/:deviceId/rotate-secret
//
// إلغاء المفتاح السابق وإظهار مفتاح جديد مرة واحدة.
// ======================================================
posDevicesRouter.post(
  '/api/pos-devices/:deviceId/rotate-secret',
  async (req, res, next) => {
    try {
      const deviceId = String(req.params.deviceId || '').trim()

      const { companyId, branchId } = req.body

      if (!isUuid(deviceId)) {
        return res.status(400).json({
          error: 'deviceId is invalid',
        })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      const authenticatedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const deviceSecret = createDeviceSecret()

      const deviceSecretHash = hashDeviceSecret(deviceSecret)

      const result = await db.query(
        `
        UPDATE pos_devices
        SET
          device_secret_hash = $1,
          secret_rotated_at = NOW(),
          updated_at = NOW()
        WHERE company_id = $2
          AND id = $3
          AND (
            $4::uuid IS NULL
            OR branch_id = $4::uuid
          )
        RETURNING
          id,
          company_id,
          branch_id,
          device_code,
          device_name,
          status,
          last_seen_at,
          registered_at,
          secret_rotated_at,
          updated_at;
        `,
        [deviceSecretHash, companyId.trim(), deviceId, authenticatedBranchId],
      )

      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'POS device was not found',
        })
      }

      return res.json({
        data: {
          device: result.rows[0],
          deviceSecret,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)
