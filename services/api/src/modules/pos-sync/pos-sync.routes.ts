import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { db } from '../../db/pool'
import {
  getPosDeviceContext,
  requirePosDevice,
} from './pos-device-auth.middleware'
import {
  OfflineSaleProcessingError,
  processOfflineSale,
} from './offline-sale.service'

export const posDeviceSyncRouter = Router()
export const posSyncAdminRouter = Router()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

function parseLimit(value: unknown, fallback = 50) {
  const numericValue = Number(value ?? fallback)

  if (!Number.isFinite(numericValue)) {
    return fallback
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

async function loadDeviceBatch(
  companyId: string,
  deviceId: string,
  batchKey: string,
) {
  const batchResult = await db.query(
    `
    SELECT *
    FROM pos_offline_sync_batches
    WHERE company_id = $1
      AND device_id = $2
      AND batch_key = $3
    LIMIT 1;
    `,
    [companyId, deviceId, batchKey],
  )

  if ((batchResult.rowCount ?? 0) === 0) {
    return null
  }

  const batch = batchResult.rows[0]

  const [itemsResult, conflictsResult] = await Promise.all([
    db.query(
      `
        SELECT *
        FROM pos_offline_sync_items
        WHERE company_id = $1
          AND batch_id = $2
        ORDER BY created_at ASC;
        `,
      [companyId, batch.id],
    ),

    db.query(
      `
        SELECT
          pc.*
        FROM pos_pending_conflicts pc

        JOIN pos_offline_sync_items psi
          ON psi.id = pc.sync_item_id
          AND psi.company_id = pc.company_id

        WHERE pc.company_id = $1
          AND psi.batch_id = $2

        ORDER BY pc.created_at ASC;
        `,
      [companyId, batch.id],
    ),
  ])

  return {
    batch,
    items: itemsResult.rows,
    conflicts: conflictsResult.rows,
  }
}

async function createConflict(options: {
  companyId: string
  branchId: string
  deviceId: string
  syncItemId: string
  conflictType: string
  severity: string
  details: Record<string, unknown>
}) {
  await db.query(
    `
    INSERT INTO pos_pending_conflicts (
      company_id,
      branch_id,
      device_id,
      sync_item_id,
      conflict_type,
      severity,
      status,
      details
    )
    VALUES (
      $1, $2, $3, $4,
      $5, $6,
      'open',
      $7
    );
    `,
    [
      options.companyId,
      options.branchId,
      options.deviceId,
      options.syncItemId,
      options.conflictType,
      options.severity,
      options.details,
    ],
  )
}

// ======================================================
// كل المسارات التالية تستخدم Device Authentication.
// ======================================================
posDeviceSyncRouter.use('/api/pos-sync', requirePosDevice)

// ======================================================
// POST /api/pos-sync/heartbeat
// ======================================================
posDeviceSyncRouter.post('/api/pos-sync/heartbeat', (req, res) => {
  const device = getPosDeviceContext(res)

  return res.json({
    data: {
      serverTime: new Date().toISOString(),
      device,
    },
  })
})

// ======================================================
// GET /api/pos-sync/bootstrap
//
// بيانات الجهاز وأماكن البيع المسموحة.
// ======================================================
posDeviceSyncRouter.get('/api/pos-sync/bootstrap', async (_req, res, next) => {
  try {
    const device = getPosDeviceContext(res)

    const locationsResult = await db.query(
      `
          SELECT
            id,
            code,
            name,
            location_type
          FROM stock_locations
          WHERE company_id = $1
            AND branch_id = $2
            AND is_active = TRUE
            AND location_type IN (
              'sales_floor',
              'branch_warehouse'
            )
          ORDER BY
            CASE
              WHEN location_type =
                   'sales_floor'
              THEN 1
              ELSE 2
            END,
            name ASC;
          `,
      [device.companyId, device.branchId],
    )

    return res.json({
      data: {
        serverTime: new Date().toISOString(),
        device,
        stockLocations: locationsResult.rows,
      },
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// POST /api/pos-sync/batches
//
// رفع حتى 100 فاتورة مؤجلة في دفعة واحدة.
// كل فاتورة تتم داخل Transaction مستقلة.
// ======================================================
posDeviceSyncRouter.post('/api/pos-sync/batches', async (req, res, next) => {
  try {
    const device = getPosDeviceContext(res)

    const body = asRecord(req.body)

    const batchKey =
      typeof body.batchKey === 'string' ? body.batchKey.trim() : ''

    const sales = body.sales

    if (!batchKey || batchKey.length > 200) {
      return res.status(400).json({
        error: 'batchKey is required and must not exceed 200 characters',
      })
    }

    if (!Array.isArray(sales) || sales.length === 0 || sales.length > 100) {
      return res.status(400).json({
        error: 'sales must contain between 1 and 100 entries',
      })
    }

    const existingBatch = await loadDeviceBatch(
      device.companyId,
      device.deviceId,
      batchKey,
    )

    if (existingBatch) {
      return res.status(200).json({
        duplicated: true,
        data: existingBatch,
      })
    }

    const batchResult = await db.query(
      `
          INSERT INTO pos_offline_sync_batches (
            company_id,
            branch_id,
            device_id,
            batch_key,
            status,
            total_items,
            request_payload
          )
          VALUES (
            $1, $2, $3, $4,
            'processing',
            $5,
            $6
          )
          ON CONFLICT (
            company_id,
            device_id,
            batch_key
          )
          DO NOTHING
          RETURNING *;
          `,
      [
        device.companyId,
        device.branchId,
        device.deviceId,
        batchKey,
        sales.length,
        body,
      ],
    )

    if ((batchResult.rowCount ?? 0) === 0) {
      const duplicateBatch = await loadDeviceBatch(
        device.companyId,
        device.deviceId,
        batchKey,
      )

      return res.status(200).json({
        duplicated: true,
        data: duplicateBatch,
      })
    }

    const batch = batchResult.rows[0]

    const results: Array<Record<string, unknown>> = []

    let processedItems = 0
    let reviewItems = 0
    let failedItems = 0

    for (let index = 0; index < sales.length; index += 1) {
      const rawSale = sales[index]
      const sale = asRecord(rawSale)

      const localEntityId =
        typeof sale.localSaleId === 'string' && sale.localSaleId.trim()
          ? sale.localSaleId.trim()
          : `invalid-${index}-${randomUUID()}`

      const idempotencyKey =
        typeof sale.idempotencyKey === 'string' && sale.idempotencyKey.trim()
          ? sale.idempotencyKey.trim()
          : `invalid-${batch.id}-${index}`

      const syncItemResult = await db.query(
        `
            INSERT INTO pos_offline_sync_items (
              company_id,
              batch_id,
              local_entity_type,
              local_entity_id,
              idempotency_key,
              status,
              item_payload,
              attempt_count,
              last_attempt_at
            )
            VALUES (
              $1, $2,
              'sale',
              $3, $4,
              'pending',
              $5,
              1,
              NOW()
            )
            RETURNING *;
            `,
        [device.companyId, batch.id, localEntityId, idempotencyKey, rawSale],
      )

      const syncItem = syncItemResult.rows[0]

      try {
        const processedSale = await processOfflineSale(device, rawSale)

        const syncStatus = processedSale.syncStatus

        if (syncStatus === 'processed' || syncStatus === 'duplicate') {
          processedItems += 1
        } else {
          reviewItems += 1
        }

        await db.query(
          `
            UPDATE pos_offline_sync_items
            SET
              status = $1,
              server_entity_type = 'sale',
              server_entity_id = $2,
              result_payload = $3,
              error_code = NULL,
              error_message = NULL,
              processed_at = NOW()
            WHERE id = $4
              AND company_id = $5;
            `,
          [
            syncStatus,
            processedSale.sale.id,
            processedSale,
            syncItem.id,
            device.companyId,
          ],
        )

        for (const conflict of processedSale.conflicts) {
          await createConflict({
            companyId: device.companyId,
            branchId: device.branchId,
            deviceId: device.deviceId,
            syncItemId: syncItem.id,
            conflictType: conflict.type,
            severity: conflict.severity,
            details: conflict.details,
          })
        }

        results.push({
          localSaleId: localEntityId,
          idempotencyKey,
          status: syncStatus,
          serverSaleId: processedSale.sale.id,
          saleNumber: processedSale.sale.sale_number,
          conflicts: processedSale.conflicts,
        })
      } catch (error) {
        const expectedError = error instanceof OfflineSaleProcessingError

        const syncStatus = expectedError ? error.syncStatus : 'failed'

        const errorCode = expectedError ? error.code : 'UNKNOWN_ERROR'

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown offline sale error'

        if (syncStatus === 'needs_review') {
          reviewItems += 1
        } else {
          failedItems += 1
        }

        await db.query(
          `
            UPDATE pos_offline_sync_items
            SET
              status = $1,
              error_code = $2,
              error_message = $3,
              result_payload = $4,
              processed_at = NOW()
            WHERE id = $5
              AND company_id = $6;
            `,
          [
            syncStatus,
            errorCode,
            errorMessage,
            {
              errorCode,
              errorMessage,
            },
            syncItem.id,
            device.companyId,
          ],
        )

        await createConflict({
          companyId: device.companyId,
          branchId: device.branchId,
          deviceId: device.deviceId,
          syncItemId: syncItem.id,
          conflictType: expectedError ? error.conflictType : 'unknown',
          severity: expectedError ? error.severity : 'critical',
          details: expectedError
            ? {
                ...error.details,
                errorCode,
                errorMessage,
              }
            : {
                errorCode,
                errorMessage,
              },
        })

        results.push({
          localSaleId: localEntityId,
          idempotencyKey,
          status: syncStatus,
          errorCode,
          errorMessage,
        })
      }
    }

    const batchStatus =
      reviewItems > 0 || failedItems > 0 ? 'completed_with_errors' : 'completed'

    const responsePayload = {
      batchKey,
      status: batchStatus,
      totalItems: sales.length,
      processedItems,
      reviewItems,
      failedItems,
      results,
    }

    await db.query(
      `
        UPDATE pos_offline_sync_batches
        SET
          status = $1,
          processed_items = $2,
          review_items = $3,
          failed_items = $4,
          processed_at = NOW(),
          response_payload = $5
        WHERE id = $6
          AND company_id = $7;
        `,
      [
        batchStatus,
        processedItems,
        reviewItems,
        failedItems,
        responsePayload,
        batch.id,
        device.companyId,
      ],
    )

    const completedBatch = await loadDeviceBatch(
      device.companyId,
      device.deviceId,
      batchKey,
    )

    return res.status(201).json({
      data: completedBatch,
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({
        error: 'Offline sync batch conflict',
      })
    }

    return next(error)
  }
})

// ======================================================
// GET /api/pos-sync/batches/:batchKey
// ======================================================
posDeviceSyncRouter.get(
  '/api/pos-sync/batches/:batchKey',
  async (req, res, next) => {
    try {
      const device = getPosDeviceContext(res)

      const batchKey = String(req.params.batchKey || '').trim()

      if (!batchKey) {
        return res.status(400).json({
          error: 'batchKey is required',
        })
      }

      const batch = await loadDeviceBatch(
        device.companyId,
        device.deviceId,
        batchKey,
      )

      if (!batch) {
        return res.status(404).json({
          error: 'Offline sync batch was not found',
        })
      }

      return res.json({
        data: batch,
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// Admin: GET /api/pos-sync-admin/batches
// ======================================================
posSyncAdminRouter.get(
  '/api/pos-sync-admin/batches',
  async (req, res, next) => {
    try {
      const companyId = req.query.companyId
      const branchId = req.query.branchId
      const status = req.query.status

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      const selectedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const selectedStatus =
        typeof status === 'string' && status.trim() ? status.trim() : null

      const result = await db.query(
        `
        SELECT
          psb.*,

          pd.device_code,
          pd.device_name,

          b.code AS branch_code,
          b.name AS branch_name

        FROM pos_offline_sync_batches psb

        JOIN pos_devices pd
          ON pd.id = psb.device_id
          AND pd.company_id = psb.company_id

        JOIN branches b
          ON b.id = psb.branch_id
          AND b.company_id = psb.company_id

        WHERE psb.company_id = $1

          AND (
            $2::uuid IS NULL
            OR psb.branch_id = $2::uuid
          )

          AND (
            $3::text IS NULL
            OR psb.status = $3::text
          )

        ORDER BY psb.received_at DESC
        LIMIT $4;
        `,
        [
          companyId.trim(),
          selectedBranchId,
          selectedStatus,
          parseLimit(req.query.limit),
        ],
      )

      return res.json({
        data: result.rows,
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// Admin: GET /api/pos-sync-admin/conflicts
// ======================================================
posSyncAdminRouter.get(
  '/api/pos-sync-admin/conflicts',
  async (req, res, next) => {
    try {
      const companyId = req.query.companyId
      const branchId = req.query.branchId
      const status = req.query.status

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      const selectedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const selectedStatus =
        typeof status === 'string' && status.trim() ? status.trim() : null

      const result = await db.query(
        `
        SELECT
          pc.*,

          pd.device_code,
          pd.device_name,

          b.code AS branch_code,
          b.name AS branch_name,

          psi.local_entity_id,
          psi.idempotency_key,
          psi.server_entity_id,
          psi.error_code,
          psi.error_message,

          reviewer.full_name
            AS reviewed_by_name

        FROM pos_pending_conflicts pc

        LEFT JOIN pos_devices pd
          ON pd.id = pc.device_id
          AND pd.company_id = pc.company_id

        JOIN branches b
          ON b.id = pc.branch_id
          AND b.company_id = pc.company_id

        LEFT JOIN pos_offline_sync_items psi
          ON psi.id = pc.sync_item_id
          AND psi.company_id = pc.company_id

        LEFT JOIN users reviewer
          ON reviewer.id = pc.reviewed_by

        WHERE pc.company_id = $1

          AND (
            $2::uuid IS NULL
            OR pc.branch_id = $2::uuid
          )

          AND (
            $3::text IS NULL
            OR pc.status = $3::text
          )

        ORDER BY
          CASE pc.severity
            WHEN 'critical' THEN 1
            WHEN 'warning' THEN 2
            ELSE 3
          END,
          pc.created_at DESC

        LIMIT $4;
        `,
        [
          companyId.trim(),
          selectedBranchId,
          selectedStatus,
          parseLimit(req.query.limit),
        ],
      )

      return res.json({
        data: result.rows,
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// Admin: PATCH conflict status
// ======================================================
posSyncAdminRouter.patch(
  '/api/pos-sync-admin/conflicts/:conflictId/status',
  async (req, res, next) => {
    try {
      const conflictId = String(req.params.conflictId || '').trim()

      const { companyId, branchId, status, createdBy } = req.body

      if (!uuidPattern.test(conflictId)) {
        return res.status(400).json({
          error: 'conflictId is invalid',
        })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      const allowedStatuses = new Set(['open', 'reviewed', 'ignored'])

      if (typeof status !== 'string' || !allowedStatuses.has(status)) {
        return res.status(400).json({
          error: 'Unsupported conflict status',
        })
      }

      const selectedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const result = await db.query(
        `
        UPDATE pos_pending_conflicts
        SET
          status = $1,

          reviewed_at =
            CASE
              WHEN $1 = 'open'
              THEN NULL
              ELSE NOW()
            END,

          reviewed_by =
            CASE
              WHEN $1 = 'open'
              THEN NULL
              ELSE $2
            END

        WHERE company_id = $3
          AND id = $4

          AND (
            $5::uuid IS NULL
            OR branch_id = $5::uuid
          )

        RETURNING *;
        `,
        [
          status,
          createdBy || null,
          companyId.trim(),
          conflictId,
          selectedBranchId,
        ],
      )

      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'POS sync conflict was not found',
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
