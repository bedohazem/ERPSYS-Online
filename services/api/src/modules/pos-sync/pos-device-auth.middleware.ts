import { createHash } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { db } from '../../db/pool'

export type PosDeviceContext = {
  deviceId: string
  companyId: string
  branchId: string
  deviceCode: string
  deviceName: string
  branchCode: string
  branchName: string
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function hashDeviceSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex')
}

export function getPosDeviceContext(res: Response): PosDeviceContext {
  const context = res.locals.posDevice as PosDeviceContext | undefined

  if (!context) {
    throw new Error('Authenticated POS device context is missing')
  }

  return context
}

// ======================================================
// مصادقة جهاز POS.
//
// Headers المطلوبة:
//
// X-POS-Device-Id
// X-POS-Device-Secret
//
// لا نعتمد على companyId أو branchId من Body.
// ======================================================
export async function requirePosDevice(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deviceId = (req.get('x-pos-device-id') || '').trim()

    const deviceSecret = (req.get('x-pos-device-secret') || '').trim()

    if (!uuidPattern.test(deviceId) || !/^[0-9a-f]{64}$/i.test(deviceSecret)) {
      return res.status(401).json({
        error: 'POS device authentication is invalid',
      })
    }

    const secretHash = hashDeviceSecret(deviceSecret)

    const result = await db.query(
      `
      SELECT
        pd.id AS device_id,
        pd.company_id,
        pd.branch_id,
        pd.device_code,
        pd.device_name,

        b.code AS branch_code,
        b.name AS branch_name

      FROM pos_devices pd

      JOIN companies c
        ON c.id = pd.company_id
        AND c.is_active = TRUE

      JOIN branches b
        ON b.id = pd.branch_id
        AND b.company_id = pd.company_id
        AND b.is_active = TRUE

      WHERE pd.id = $1
        AND pd.device_secret_hash = $2
        AND pd.status = 'active'

      LIMIT 1;
      `,
      [deviceId, secretHash],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(401).json({
        error: 'POS device authentication is invalid',
      })
    }

    const row = result.rows[0]

    const context: PosDeviceContext = {
      deviceId: row.device_id,
      companyId: row.company_id,
      branchId: row.branch_id,
      deviceCode: row.device_code,
      deviceName: row.device_name,
      branchCode: row.branch_code,
      branchName: row.branch_name,
    }

    res.locals.posDevice = context

    // لا نحدث Last Seen مع كل Request.
    await db.query(
      `
      UPDATE pos_devices
      SET
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND (
          last_seen_at IS NULL
          OR last_seen_at <
             NOW() - INTERVAL '1 minute'
        );
      `,
      [context.deviceId],
    )

    return next()
  } catch (error) {
    return next(error)
  }
}
