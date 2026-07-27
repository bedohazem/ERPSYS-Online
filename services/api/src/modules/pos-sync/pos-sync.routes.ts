import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Router } from 'express'
import { db } from '../../db/pool'
import {
  getAuthContext,
  hashSessionToken,
  requireAuth,
  requirePermission,
} from '../auth/auth.middleware'
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

function sanitizeOfflineSalePayload(value: unknown): Record<string, unknown> {
  const sale = asRecord(value)

  // المفتاح يستخدم أثناء المعالجة فقط.
  // ممنوع تخزينه داخل request_payload أو item_payload.
  const { cashierGrantToken: _cashierGrantToken, ...safeSale } = sale

  return safeSale
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

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

function parseNonNegativeMoney(value: unknown, fieldName: string) {
  const amount = roundMoney(Number(value))

  if (!Number.isFinite(amount) || amount < 0 || amount > 999_999_999_999) {
    throw new Error(`${fieldName} must be a valid non-negative amount`)
  }

  return amount
}

function createShiftNumber() {
  const now = new Date()

  const datePart = now.toISOString().slice(0, 10).replaceAll('-', '')

  return (
    `POS-${datePart}-` +
    `${Date.now().toString(36).toUpperCase()}-` +
    randomBytes(2).toString('hex').toUpperCase()
  )
}

function mapCashierShift(row: Record<string, unknown>) {
  return {
    id: row.id,

    shiftNumber: row.shift_number,

    openingCash: String(row.opening_cash),

    closingCash: row.closing_cash === null ? null : String(row.closing_cash),

    expectedCash: row.expected_cash === null ? null : String(row.expected_cash),

    difference: row.difference === null ? null : String(row.difference),

    netSalesCash:
      row.net_sales_cash === null || row.net_sales_cash === undefined
        ? null
        : String(row.net_sales_cash),

    cashReturns:
      row.cash_returns === null || row.cash_returns === undefined
        ? null
        : String(row.cash_returns),

    netExchangeCash:
      row.net_exchange_cash === null || row.net_exchange_cash === undefined
        ? null
        : String(row.net_exchange_cash),

    salesCount:
      row.sales_count === null || row.sales_count === undefined
        ? null
        : Number(row.sales_count),

    voidedSalesCount:
      row.voided_sales_count === null || row.voided_sales_count === undefined
        ? null
        : Number(row.voided_sales_count),

    returnsCount:
      row.returns_count === null || row.returns_count === undefined
        ? null
        : Number(row.returns_count),

    exchangesCount:
      row.exchanges_count === null || row.exchanges_count === undefined
        ? null
        : Number(row.exchanges_count),

    closedBy: row.closed_by ?? null,

    closingNote: typeof row.closing_note === 'string' ? row.closing_note : null,

    settlementSnapshot:
      typeof row.settlement_snapshot === 'object' &&
      row.settlement_snapshot !== null
        ? row.settlement_snapshot
        : null,

    openedAt: row.opened_at,
    closedAt: row.closed_at,

    status: row.status,

    cashierId: row.cashier_id,

    deviceId: row.pos_device_id,

    cashierGrantId: row.pos_cashier_grant_id,
  }
}

function cashierMatchesDevice(res: Parameters<typeof getAuthContext>[0]) {
  const device = getPosDeviceContext(res)

  const auth = getAuthContext(res)

  return {
    device,
    auth,

    matches:
      auth.companyId === device.companyId && auth.branchId === device.branchId,
  }
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

async function refreshSyncBatchCounters(
  client: PoolClient,
  companyId: string,
  batchId: string,
) {
  const countsResult = await client.query(
    `
      SELECT
        COUNT(*)::int
          AS total_items,

        COUNT(*) FILTER (
          WHERE status IN (
            'processed',
            'duplicate'
          )
        )::int
          AS processed_items,

        COUNT(*) FILTER (
          WHERE status =
            'needs_review'
        )::int
          AS review_items,

        COUNT(*) FILTER (
          WHERE status = 'failed'
        )::int
          AS failed_items

      FROM pos_offline_sync_items

      WHERE company_id = $1
        AND batch_id = $2;
      `,
    [companyId, batchId],
  )

  const counts = countsResult.rows[0]

  const totalItems = Number(counts.total_items)

  const processedItems = Number(counts.processed_items)

  const reviewItems = Number(counts.review_items)

  const failedItems = Number(counts.failed_items)

  const status =
    reviewItems > 0 || failedItems > 0 ? 'completed_with_errors' : 'completed'

  await client.query(
    `
    UPDATE pos_offline_sync_batches

    SET
      total_items = $1,
      processed_items = $2,
      review_items = $3,
      failed_items = $4,
      status = $5,

      response_payload =
        COALESCE(
          response_payload,
          '{}'::jsonb
        ) ||
        jsonb_build_object(
          'status', $5,
          'totalItems', $1,
          'processedItems', $2,
          'reviewItems', $3,
          'failedItems', $4
        )

    WHERE company_id = $6
      AND id = $7;
    `,
    [
      totalItems,
      processedItems,
      reviewItems,
      failedItems,
      status,

      companyId,
      batchId,
    ],
  )

  return {
    totalItems,
    processedItems,
    reviewItems,
    failedItems,
    status,
  }
}

async function finalizeResolvedSyncItem(
  client: PoolClient,

  companyId: string,
  syncItemId: string,

  resolvedBy: string,
  resolutionAction: string,
) {
  const itemResult = await client.query(
    `
      SELECT
        id,
        batch_id,
        server_entity_type,
        server_entity_id

      FROM pos_offline_sync_items

      WHERE company_id = $1
        AND id = $2

      FOR UPDATE;
      `,
    [companyId, syncItemId],
  )

  if ((itemResult.rowCount ?? 0) === 0) {
    throw new Error('POS sync item was not found')
  }

  const item = itemResult.rows[0]

  const remainingResult = await client.query(
    `
      SELECT COUNT(*)::int
        AS total

      FROM pos_pending_conflicts

      WHERE company_id = $1
        AND sync_item_id = $2

        -- التجاهل أو المراجعة لا يعنيان
        -- أن التعارض تم حله فعليًا.
        AND status <> 'resolved';
      `,
    [companyId, syncItemId],
  )

  const remainingConflicts = Number(remainingResult.rows[0].total)

  if (
    remainingConflicts > 0 ||
    item.server_entity_type !== 'sale' ||
    !item.server_entity_id
  ) {
    const batch = await refreshSyncBatchCounters(
      client,
      companyId,
      item.batch_id,
    )

    return {
      finalized: false,
      remainingConflicts,
      batch,
    }
  }

  await client.query(
    `
    UPDATE sales

    SET status = 'completed'

    WHERE company_id = $1
      AND id = $2
      AND status =
          'pending_review';
    `,
    [companyId, item.server_entity_id],
  )

  await client.query(
    `
    UPDATE pos_offline_sync_items

    SET
      status = 'processed',
      error_code = NULL,
      error_message = NULL,
      processed_at = NOW(),

      result_payload =
        COALESCE(
          result_payload,
          '{}'::jsonb
        ) ||
        jsonb_build_object(
          'resolution',
          jsonb_build_object(
            'action', $3,
            'resolvedBy', $4,
            'resolvedAt', NOW()
          )
        )

    WHERE company_id = $1
      AND id = $2;
    `,
    [companyId, syncItemId, resolutionAction, resolvedBy],
  )

  const batch = await refreshSyncBatchCounters(client, companyId, item.batch_id)

  return {
    finalized: true,
    remainingConflicts: 0,
    batch,
  }
}

// ======================================================
// كل المسارات التالية تستخدم Device Authentication.
// ======================================================
posDeviceSyncRouter.use('/api/pos-sync', requirePosDevice)

// ======================================================
// POST /api/pos-sync/cashier-grants
//
// يحتاج في نفس الطلب إلى:
// - Device Authentication
// - Bearer Authentication
// - sales.create
//
// المفتاح الخام يظهر مرة واحدة فقط.
// ======================================================
posDeviceSyncRouter.post(
  '/api/pos-sync/cashier-grants',

  requireAuth,

  requirePermission('sales.create'),

  async (_req, res, next) => {
    try {
      const device = getPosDeviceContext(res)

      const auth = getAuthContext(res)

      if (
        auth.companyId !== device.companyId ||
        auth.branchId !== device.branchId
      ) {
        return res.status(403).json({
          error: 'Cashier session does not match POS device branch',
        })
      }

      const grantToken = randomBytes(32).toString('hex')

      const grantTokenHash = hashSessionToken(grantToken)

      const result = await db.query(
        `
          INSERT INTO pos_cashier_grants (
            company_id,
            branch_id,
            device_id,
            cashier_id,
            auth_session_id,
            token_hash,
            expires_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,

            -- يسمح للكاشير بالبيع Offline
            -- لمدة سبعة أيام من المصادقة.
            NOW() + INTERVAL '7 days'
          )
          RETURNING
            id,
            cashier_id,
            device_id,
            issued_at,
            expires_at;
          `,
        [
          device.companyId,
          device.branchId,
          device.deviceId,
          auth.userId,
          auth.sessionId,
          grantTokenHash,
        ],
      )

      const grant = result.rows[0]

      return res.status(201).json({
        data: {
          grantId: grant.id,

          grantToken,

          issuedAt: grant.issued_at,

          expiresAt: grant.expires_at,

          cashierId: grant.cashier_id,

          deviceId: grant.device_id,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/pos-sync/shifts/current
// ======================================================
posDeviceSyncRouter.get(
  '/api/pos-sync/shifts/current',

  requireAuth,

  requirePermission('sales.create'),

  async (_req, res, next) => {
    try {
      const { device, auth, matches } = cashierMatchesDevice(res)

      if (!matches) {
        return res.status(403).json({
          error: 'Cashier session does not match POS device branch',
        })
      }

      const result = await db.query(
        `
          SELECT *
          FROM cashier_shifts

          WHERE company_id = $1
            AND branch_id = $2
            AND cashier_id = $3
            AND pos_device_id = $4
            AND status = 'open'

          ORDER BY opened_at DESC
          LIMIT 1;
          `,
        [device.companyId, device.branchId, auth.userId, device.deviceId],
      )

      const shift = result.rows[0]

      return res.json({
        data: shift ? mapCashierShift(shift) : null,
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// POST /api/pos-sync/shifts/open
//
// Body:
// {
//   openingCash
// }
// ======================================================
posDeviceSyncRouter.post(
  '/api/pos-sync/shifts/open',

  requireAuth,

  requirePermission('sales.create'),

  async (req, res, next) => {
    const client = await db.connect()

    try {
      const { device, auth, matches } = cashierMatchesDevice(res)

      if (!matches) {
        return res.status(403).json({
          error: 'Cashier session does not match POS device branch',
        })
      }

      const body = asRecord(req.body)

      const openingCash = parseNonNegativeMoney(
        body.openingCash ?? 0,
        'openingCash',
      )

      await client.query('BEGIN')

      const grantResult = await client.query(
        `
          SELECT id
          FROM pos_cashier_grants

          WHERE company_id = $1
            AND branch_id = $2
            AND device_id = $3
            AND cashier_id = $4
            AND auth_session_id = $5

            AND revoked_at IS NULL
            AND expires_at > NOW()

          ORDER BY issued_at DESC
          LIMIT 1

          FOR SHARE;
          `,
        [
          device.companyId,
          device.branchId,
          device.deviceId,
          auth.userId,
          auth.sessionId,
        ],
      )

      if ((grantResult.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'No active cashier offline grant exists for this session',
        })
      }

      const cashierGrantId = grantResult.rows[0].id

      const existingResult = await client.query(
        `
          SELECT *
          FROM cashier_shifts

          WHERE company_id = $1
            AND status = 'open'

            AND (
              cashier_id = $2
              OR pos_device_id = $3
            )

          FOR UPDATE;
          `,
        [device.companyId, auth.userId, device.deviceId],
      )

      const existingShift = existingResult.rows[0]

      if (existingShift) {
        const sameShift =
          existingShift.cashier_id === auth.userId &&
          existingShift.pos_device_id === device.deviceId

        if (!sameShift) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            error: 'Cashier or POS device already has another open shift',
          })
        }

        await client.query('COMMIT')

        return res.status(200).json({
          reused: true,

          data: mapCashierShift(existingShift),
        })
      }

      const shiftResult = await client.query(
        `
          INSERT INTO cashier_shifts (
            company_id,
            branch_id,
            cashier_id,

            pos_device_id,
            pos_cashier_grant_id,

            shift_number,
            opening_cash,
            status,
            opened_at
          )
          VALUES (
            $1, $2, $3,
            $4, $5,
            $6, $7,
            'open',
            NOW()
          )
          RETURNING *;
          `,
        [
          device.companyId,
          device.branchId,
          auth.userId,

          device.deviceId,
          cashierGrantId,

          createShiftNumber(),
          openingCash,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        reused: false,

        data: mapCashierShift(shiftResult.rows[0]),
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (isUniqueViolation(error)) {
        return res.status(409).json({
          error: 'Cashier or POS device already has an open shift',
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// POST /api/pos-sync/shifts/:shiftId/close
//
// Body:
// {
//   closingCash
// }
// ======================================================
posDeviceSyncRouter.post(
  '/api/pos-sync/shifts/:shiftId/close',

  requireAuth,

  requirePermission('sales.create'),

  async (req, res, next) => {
    const client = await db.connect()

    try {
      const { device, auth, matches } = cashierMatchesDevice(res)

      if (!matches) {
        return res.status(403).json({
          error: 'Cashier session does not match POS device branch',
        })
      }

      const rawShiftId = req.params.shiftId

      const shiftId = Array.isArray(rawShiftId) ? rawShiftId[0] : rawShiftId

      if (typeof shiftId !== 'string' || !uuidPattern.test(shiftId)) {
        return res.status(400).json({
          error: 'shiftId is invalid',
        })
      }

      const body = asRecord(req.body)

      const closingCash = parseNonNegativeMoney(body.closingCash, 'closingCash')

      const rawClosingNote = body.closingNote

      if (
        rawClosingNote !== undefined &&
        rawClosingNote !== null &&
        typeof rawClosingNote !== 'string'
      ) {
        return res.status(400).json({
          error: 'closingNote must be a string',
        })
      }

      const closingNote =
        typeof rawClosingNote === 'string' && rawClosingNote.trim()
          ? rawClosingNote.trim()
          : null

      if (closingNote && closingNote.length > 500) {
        return res.status(400).json({
          error: 'closingNote is too long',
        })
      }

      await client.query('BEGIN')

      const shiftResult = await client.query(
        `
          SELECT *
          FROM cashier_shifts

          WHERE company_id = $1
            AND id = $2
            AND branch_id = $3
            AND cashier_id = $4
            AND pos_device_id = $5
            AND status = 'open'

          FOR UPDATE;
          `,
        [
          device.companyId,
          shiftId,
          device.branchId,
          auth.userId,
          device.deviceId,
        ],
      )

      if ((shiftResult.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Open cashier shift was not found',
        })
      }

      const shift = shiftResult.rows[0]

      const cashResult = await client.query(
        `
          SELECT
            COALESCE(
              (
                SELECT SUM(
                  cash_sales.net_cash
                )

                FROM (
                  SELECT
                    s.id,

                    COALESCE(
                      SUM(p.amount) FILTER (
                        WHERE p.method =
                              'cash'

                          AND p.payment_role =
                              'sale_collection'

                          AND p.payment_direction =
                              'received_from_customer'
                      ),
                      0
                    )
                    -
                    COALESCE(
                      s.change_total,
                      0
                    )
                      AS net_cash

                  FROM sales s

                  LEFT JOIN payments p
                    ON p.sale_id = s.id
                    AND p.company_id =
                        s.company_id

                  WHERE s.company_id = $1
                    AND s.shift_id = $2

                    AND s.status IN (
                      'completed',
                      'pending_review',
                      'refunded'
                    )

                  GROUP BY
                    s.id,
                    s.change_total
                ) cash_sales
              ),
              0
            ) AS sales_cash,

            COALESCE(
              (
                SELECT SUM(rr.amount)

                FROM return_refunds rr

                JOIN returns r
                  ON r.id =
                     rr.return_id
                  AND r.company_id =
                      rr.company_id

                WHERE r.company_id = $1
                  AND r.branch_id = $3
                  AND r.created_by = $4
                  AND r.created_at >=
                      $5::timestamptz
                  AND r.created_at <= NOW()
                  AND rr.method = 'cash'

                  AND r.status IN (
                    'completed',
                    'pending_review'
                  )
              ),
              0
            ) AS returns_cash,

            COALESCE(
              (
                SELECT SUM(
                  CASE
                    WHEN ep.payment_direction =
                         'paid_by_customer'
                    THEN ep.amount
                    ELSE -ep.amount
                  END
                )

                FROM exchange_payments ep

                JOIN exchanges e
                  ON e.id =
                     ep.exchange_id
                  AND e.company_id =
                      ep.company_id

                WHERE e.company_id = $1
                  AND e.branch_id = $3
                  AND e.created_by = $4
                  AND e.created_at >=
                      $5::timestamptz
                  AND e.created_at <= NOW()
                  AND ep.method = 'cash'

                  AND e.status IN (
                    'completed',
                    'pending_review'
                  )
              ),
              0
            ) AS exchange_cash_net,
            (
              SELECT COUNT(*)::int

              FROM sales s

              WHERE s.company_id = $1
                AND s.shift_id = $2

                AND s.status IN (
                  'completed',
                  'pending_review',
                  'refunded'
                )
            ) AS sales_count,

            (
              SELECT COUNT(*)::int

              FROM sales s

              WHERE s.company_id = $1
                AND s.shift_id = $2
                AND s.status = 'voided'
            ) AS voided_sales_count,

            (
              SELECT COUNT(*)::int

              FROM returns r

              WHERE r.company_id = $1
                AND r.branch_id = $3
                AND r.created_by = $4

                AND r.created_at >=
                    $5::timestamptz

                AND r.created_at <= NOW()

                AND r.status IN (
                  'completed',
                  'pending_review'
                )
            ) AS returns_count,

            (
              SELECT COUNT(*)::int

              FROM exchanges e

              WHERE e.company_id = $1
                AND e.branch_id = $3
                AND e.created_by = $4

                AND e.created_at >=
                    $5::timestamptz

                AND e.created_at <= NOW()

                AND e.status IN (
                  'completed',
                  'pending_review'
                )
            ) AS exchanges_count;
          `,
        [
          device.companyId,
          shiftId,
          device.branchId,
          auth.userId,
          shift.opened_at,
        ],
      )

      const cash = cashResult.rows[0]

      const openingCash = Number(shift.opening_cash)

      const salesCash = Number(cash.sales_cash)

      const returnsCash = Number(cash.returns_cash)

      const exchangeCashNet = Number(cash.exchange_cash_net)

      const salesCount = Number(cash.sales_count)

      const voidedSalesCount = Number(cash.voided_sales_count)

      const returnsCount = Number(cash.returns_count)

      const exchangesCount = Number(cash.exchanges_count)

      const expectedCash = roundMoney(
        openingCash + salesCash - returnsCash + exchangeCashNet,
      )

      const difference = roundMoney(closingCash - expectedCash)

      const settlementSnapshot = {
        version: 1,

        computedAt: new Date().toISOString(),

        shift: {
          id: shift.id,

          shiftNumber: shift.shift_number,

          companyId: shift.company_id,

          branchId: shift.branch_id,

          cashierId: shift.cashier_id,

          deviceId: shift.pos_device_id,

          openedAt: shift.opened_at,
        },

        cash: {
          openingCash: roundMoney(openingCash),

          netSalesCash: roundMoney(salesCash),

          cashReturns: roundMoney(returnsCash),

          netExchangeCash: roundMoney(exchangeCashNet),

          expectedCash,

          closingCash,

          difference,
        },

        documents: {
          salesCount,

          voidedSalesCount,

          returnsCount,

          exchangesCount,
        },
      }

      const closedResult = await client.query(
        `
        UPDATE cashier_shifts

        SET
          closing_cash = $1,
          expected_cash = $2,
          difference = $3,

          net_sales_cash = $4,
          cash_returns = $5,
          net_exchange_cash = $6,

          sales_count = $7,
          voided_sales_count = $8,
          returns_count = $9,
          exchanges_count = $10,

          closed_by = $11,
          closing_note = $12,

          settlement_snapshot =
            $13::jsonb,

          closed_at = NOW(),
          status = 'closed'

        WHERE company_id = $14
          AND id = $15

        RETURNING *;
        `,
        [
          closingCash,
          expectedCash,
          difference,

          roundMoney(salesCash),

          roundMoney(returnsCash),

          roundMoney(exchangeCashNet),

          salesCount,
          voidedSalesCount,
          returnsCount,
          exchangesCount,

          auth.userId,
          closingNote,

          JSON.stringify(settlementSnapshot),

          device.companyId,
          shiftId,
        ],
      )

      await client.query('COMMIT')

      await client.query(
        `
        INSERT INTO audit_logs (
          company_id,
          branch_id,
          user_id,

          action,
          entity_type,
          entity_id,

          old_data,
          new_data,

          ip_address,
          user_agent
        )
        VALUES (
          $1, $2, $3,
          'cashier_shift.close',
          'cashier_shift',
          $4,
          $5::jsonb,
          $6::jsonb,
          $7,
          $8
        );
        `,
        [
          device.companyId,
          device.branchId,
          auth.userId,

          shiftId,

          JSON.stringify({
            status: shift.status,

            openingCash: shift.opening_cash,

            openedAt: shift.opened_at,
          }),

          JSON.stringify({
            status: 'closed',

            closingNote,

            settlement: settlementSnapshot,
          }),

          req.ip || null,

          req.get('user-agent') || null,
        ],
      )

      return res.json({
        data: {
          shift: mapCashierShift(closedResult.rows[0]),

          cashSummary: {
            openingCash: roundMoney(openingCash),
            salesCash: roundMoney(salesCash),
            returnsCash: roundMoney(returnsCash),
            exchangeCashNet: roundMoney(exchangeCashNet),
            salesCount,
            voidedSalesCount,
            returnsCount,
            exchangesCount,
            expectedCash,
            closingCash,
            difference,
            closingNote,
            settlementVersion: 1,
          },
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      return next(error)
    } finally {
      client.release()
    }
  },
)

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
// GET /api/pos-sync/catalog
//
// Snapshot كامل للأصناف والأسعار والباركود.
//
// لا يعيد هذا المسار أي كميات مخزون.
// الكميات تظل داخل PostgreSQL فقط.
// ======================================================
posDeviceSyncRouter.get('/api/pos-sync/catalog', async (_req, res, next) => {
  try {
    const device = getPosDeviceContext(res)

    const result = await db.query(
      `
        SELECT
          pv.id AS variant_id,
          pv.product_id,

          p.name AS product_name,

          pv.sku,
          pv.primary_barcode,

          fs.name AS size_name,
          fc.name AS color_name,

          pv.selling_price,

          COALESCE(
            ARRAY_AGG(
              DISTINCT vb.barcode
            ) FILTER (
              WHERE vb.barcode IS NOT NULL
            ),
            ARRAY[]::text[]
          ) AS barcodes

        FROM product_variants pv

        JOIN products p
          ON p.id = pv.product_id
          AND p.company_id =
              pv.company_id
          AND p.status = 'active'

        LEFT JOIN fashion_sizes fs
          ON fs.id = pv.size_id
          AND fs.company_id =
              pv.company_id

        LEFT JOIN fashion_colors fc
          ON fc.id = pv.color_id
          AND fc.company_id =
              pv.company_id

        LEFT JOIN variant_barcodes vb
          ON vb.variant_id = pv.id
          AND vb.company_id =
              pv.company_id

        WHERE pv.company_id = $1
          AND pv.status = 'active'

        GROUP BY
          pv.id,
          pv.product_id,
          p.name,
          pv.sku,
          pv.primary_barcode,
          fs.name,
          fc.name,
          pv.selling_price

        ORDER BY
          p.name ASC,
          pv.sku ASC;
        `,
      [device.companyId],
    )

    return res.json({
      data: {
        serverTime: new Date().toISOString(),

        items: result.rows,
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

        {
          ...body,

          sales: sales.map(sanitizeOfflineSalePayload),
        },
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
        [
          device.companyId,
          batch.id,
          localEntityId,
          idempotencyKey,

          sanitizeOfflineSalePayload(rawSale),
        ],
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
// POST /api/pos-sync/review-results
//
// يستخدمه Desktop POS لمعرفة هل تم حل
// فواتير needs_review من Web Admin.
// ======================================================
posDeviceSyncRouter.post(
  '/api/pos-sync/review-results',

  async (req, res, next) => {
    try {
      const device = getPosDeviceContext(res)

      const body = asRecord(req.body)

      const rawLocalSaleIds = body.localSaleIds

      if (
        !Array.isArray(rawLocalSaleIds) ||
        rawLocalSaleIds.length === 0 ||
        rawLocalSaleIds.length > 100
      ) {
        return res.status(400).json({
          error: 'localSaleIds must contain between 1 and 100 entries',
        })
      }

      const localSaleIds = [
        ...new Set(
          rawLocalSaleIds
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length > 0 && value.length <= 200),
        ),
      ]

      if (localSaleIds.length === 0) {
        return res.status(400).json({
          error: 'localSaleIds are invalid',
        })
      }

      const result = await db.query(
        `
          SELECT DISTINCT ON (
            psi.local_entity_id
          )
            psi.local_entity_id,
            psi.status,
            psi.server_entity_id,
            psi.error_code,
            psi.error_message,
            psi.processed_at

          FROM pos_offline_sync_items psi

          JOIN pos_offline_sync_batches psb
            ON psb.id =
               psi.batch_id
            AND psb.company_id =
                psi.company_id

          WHERE psi.company_id = $1
            AND psb.device_id = $2

            AND psi.local_entity_id =
                ANY($3::text[])

          ORDER BY
            psi.local_entity_id,
            psi.created_at DESC;
          `,
        [device.companyId, device.deviceId, localSaleIds],
      )

      const rowsByLocalSaleId = new Map(
        result.rows.map((row) => [row.local_entity_id, row]),
      )

      return res.json({
        data: {
          items: localSaleIds.map(
            (localSaleId) =>
              rowsByLocalSaleId.get(localSaleId) ?? {
                local_entity_id: localSaleId,

                status: 'needs_review',

                server_entity_id: null,

                error_code: 'SYNC_ITEM_NOT_FOUND',

                error_message: 'لم يتم العثور على محاولة المزامنة على السيرفر.',

                processed_at: null,
              },
          ),
        },
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
// Admin: GET /api/pos-sync-admin/batches/:batchId
//
// عرض الدفعة مع كل محاولات الرفع والتعارضات التابعة لها.
// ======================================================
posSyncAdminRouter.get(
  '/api/pos-sync-admin/batches/:batchId',
  async (req, res, next) => {
    try {
      const batchId = String(req.params.batchId || '').trim()

      const companyId = req.query.companyId
      const branchId = req.query.branchId

      if (!uuidPattern.test(batchId)) {
        return res.status(400).json({
          error: 'batchId is invalid',
        })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      const selectedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const batchResult = await db.query(
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
          AND psb.id = $2

          AND (
            $3::uuid IS NULL
            OR psb.branch_id = $3::uuid
          )

        LIMIT 1;
        `,
        [companyId.trim(), batchId, selectedBranchId],
      )

      if ((batchResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'POS synchronization batch was not found',
        })
      }

      const itemsResult = await db.query(
        `
        SELECT
          psi.*,

          s.sale_number,
          s.status AS sale_status,
          s.occurred_at AS sale_occurred_at

        FROM pos_offline_sync_items psi

        LEFT JOIN sales s
          ON s.company_id = psi.company_id
          AND s.id = psi.server_entity_id
          AND psi.server_entity_type = 'sale'

        WHERE psi.company_id = $1
          AND psi.batch_id = $2

        ORDER BY
          psi.created_at ASC,
          psi.id ASC;
        `,
        [companyId.trim(), batchId],
      )

      const conflictsResult = await db.query(
        `
        SELECT
          pc.*,

          psi.local_entity_id,
          psi.idempotency_key,
          psi.server_entity_id,

          reviewer.full_name
            AS reviewed_by_name

        FROM pos_pending_conflicts pc

        JOIN pos_offline_sync_items psi
          ON psi.id = pc.sync_item_id
          AND psi.company_id = pc.company_id

        LEFT JOIN users reviewer
          ON reviewer.id = pc.reviewed_by

        WHERE pc.company_id = $1
          AND psi.batch_id = $2

        ORDER BY
          pc.created_at ASC;
        `,
        [companyId.trim(), batchId],
      )

      return res.json({
        data: {
          batch: batchResult.rows[0],
          items: itemsResult.rows,
          conflicts: conflictsResult.rows,
        },
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
// Admin: POST conflict resolution
//
// Actions:
// - accept_submitted_price
// - retry_stock_deduction
// ======================================================
posSyncAdminRouter.post(
  '/api/pos-sync-admin/conflicts/:conflictId/resolve',

  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const rawConflictId = req.params.conflictId

      const conflictId = Array.isArray(rawConflictId)
        ? rawConflictId[0]
        : rawConflictId

      if (typeof conflictId !== 'string' || !uuidPattern.test(conflictId)) {
        return res.status(400).json({
          error: 'conflictId is invalid',
        })
      }

      const body = asRecord(req.body)

      const action = typeof body.action === 'string' ? body.action.trim() : ''

      const resolutionNote =
        typeof body.note === 'string' && body.note.trim()
          ? body.note.trim().slice(0, 500)
          : null

      const allowedActions = new Set([
        'accept_submitted_price',
        'retry_stock_deduction',
      ])

      if (!allowedActions.has(action)) {
        return res.status(400).json({
          error: 'Unsupported resolution action',
        })
      }

      await client.query('BEGIN')

      const conflictResult = await client.query(
        `
          SELECT
            pc.*,

            psi.batch_id,
            psi.server_entity_type,
            psi.server_entity_id,
            psi.status
              AS sync_item_status

          FROM pos_pending_conflicts pc

          JOIN pos_offline_sync_items psi
            ON psi.id =
               pc.sync_item_id
            AND psi.company_id =
                pc.company_id

          WHERE pc.company_id = $1
            AND pc.id = $2

            AND (
              $3::uuid IS NULL
              OR pc.branch_id =
                 $3::uuid
            )

          FOR UPDATE OF pc, psi;
          `,
        [auth.companyId, conflictId, auth.branchId],
      )

      if ((conflictResult.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'POS sync conflict was not found',
        })
      }

      const conflict = conflictResult.rows[0]

      if (
        !conflict.sync_item_id ||
        conflict.server_entity_type !== 'sale' ||
        !conflict.server_entity_id
      ) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error:
            'This conflict has no server sale that can be resolved automatically',
        })
      }

      if (
        action === 'accept_submitted_price' &&
        conflict.conflict_type !== 'price_changed'
      ) {
        await client.query('ROLLBACK')

        return res.status(400).json({
          error: 'accept_submitted_price supports price_changed conflicts only',
        })
      }

      if (
        action === 'retry_stock_deduction' &&
        conflict.conflict_type !== 'negative_stock'
      ) {
        await client.query('ROLLBACK')

        return res.status(400).json({
          error: 'retry_stock_deduction supports negative_stock conflicts only',
        })
      }

      if (action === 'accept_submitted_price') {
        await client.query(
          `
          UPDATE pos_pending_conflicts

          SET
            status = 'resolved',

            resolution_action = $1,
            resolution_note = $2,

            resolved_at = NOW(),
            resolved_by = $3,

            reviewed_at =
              COALESCE(
                reviewed_at,
                NOW()
              ),

            reviewed_by =
              COALESCE(
                reviewed_by,
                $3
              )

          WHERE company_id = $4
            AND sync_item_id = $5
            AND conflict_type =
                'price_changed'

            AND status IN (
              'open',
              'reviewed',
              'ignored'
            );
          `,
          [
            action,
            resolutionNote,
            auth.userId,

            auth.companyId,
            conflict.sync_item_id,
          ],
        )
      }

      if (action === 'retry_stock_deduction') {
        const saleResult = await client.query(
          `
            SELECT
              id,
              branch_id,
              stock_location_id,
              cashier_id,
              sale_number,
              status

            FROM sales

            WHERE company_id = $1
              AND id = $2

            FOR UPDATE;
            `,
          [auth.companyId, conflict.server_entity_id],
        )

        if ((saleResult.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')

          return res.status(404).json({
            error: 'Linked offline sale was not found',
          })
        }

        const sale = saleResult.rows[0]

        if (!['pending_review', 'completed'].includes(sale.status)) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            error: 'Linked sale status does not allow stock resolution',
          })
        }

        const saleItemsResult = await client.query(
          `
            SELECT
              variant_id,
              quantity

            FROM sale_items

            WHERE company_id = $1
              AND sale_id = $2

            ORDER BY variant_id ASC;
            `,
          [auth.companyId, sale.id],
        )

        if ((saleItemsResult.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            error: 'Linked sale has no items',
          })
        }

        const movementResult = await client.query(
          `
            SELECT COUNT(*)::int
              AS total

            FROM stock_movements

            WHERE company_id = $1
              AND movement_type =
                  'sale'
              AND reference_type =
                  'sale'
              AND reference_id = $2;
            `,
          [auth.companyId, sale.id],
        )

        const existingMovementCount = Number(movementResult.rows[0].total)

        if (
          existingMovementCount > 0 &&
          existingMovementCount !== saleItemsResult.rows.length
        ) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            error:
              'Sale has an incomplete stock movement set and requires manual investigation',
          })
        }

        if (existingMovementCount === 0) {
          for (const item of saleItemsResult.rows) {
            await client.query(
              `
              INSERT INTO stock_balances (
                company_id,
                branch_id,
                stock_location_id,
                variant_id,
                quantity
              )
              VALUES (
                $1, $2, $3, $4, 0
              )

              ON CONFLICT (
                company_id,
                stock_location_id,
                variant_id
              )
              DO NOTHING;
              `,
              [
                auth.companyId,
                sale.branch_id,
                sale.stock_location_id,
                item.variant_id,
              ],
            )
          }

          const variantIds = saleItemsResult.rows.map((item) => item.variant_id)

          const balancesResult = await client.query(
            `
              SELECT
                variant_id,
                quantity

              FROM stock_balances

              WHERE company_id = $1
                AND stock_location_id =
                    $2

                AND variant_id =
                    ANY($3::uuid[])

              ORDER BY variant_id ASC

              FOR UPDATE;
              `,
            [auth.companyId, sale.stock_location_id, variantIds],
          )

          const balances = new Map(
            balancesResult.rows.map((row) => [
              row.variant_id,
              Number(row.quantity),
            ]),
          )

          const shortages = saleItemsResult.rows
            .map((item) => {
              const availableQuantity = balances.get(item.variant_id) ?? 0

              const requestedQuantity = Number(item.quantity)

              return {
                variantId: item.variant_id,

                availableQuantity,
                requestedQuantity,
              }
            })
            .filter((item) => item.availableQuantity < item.requestedQuantity)

          if (shortages.length > 0) {
            await client.query('ROLLBACK')

            return res.status(409).json({
              error: 'Stock is still insufficient for this sale',

              details: {
                shortages,
              },
            })
          }

          for (const item of saleItemsResult.rows) {
            const quantityBefore = balances.get(item.variant_id) ?? 0

            const soldQuantity = Number(item.quantity)

            const quantityAfter = roundQuantity(quantityBefore - soldQuantity)

            await client.query(
              `
              UPDATE stock_balances

              SET
                quantity = $1,
                updated_at = NOW()

              WHERE company_id = $2
                AND stock_location_id =
                    $3
                AND variant_id = $4;
              `,
              [
                quantityAfter,

                auth.companyId,
                sale.stock_location_id,
                item.variant_id,
              ],
            )

            await client.query(
              `
              INSERT INTO stock_movements (
                company_id,
                branch_id,
                stock_location_id,
                variant_id,

                movement_type,
                quantity,
                quantity_before,
                quantity_after,

                reference_type,
                reference_id,
                note,
                created_by
              )
              VALUES (
                $1, $2, $3, $4,
                'sale',
                $5, $6, $7,
                'sale',
                $8,
                $9,
                $10
              );
              `,
              [
                auth.companyId,
                sale.branch_id,
                sale.stock_location_id,
                item.variant_id,

                -Math.abs(soldQuantity),

                quantityBefore,
                quantityAfter,

                sale.id,

                `Resolved offline POS sale ${sale.sale_number}`,

                auth.userId,
              ],
            )
          }
        }

        await client.query(
          `
          UPDATE pos_pending_conflicts

          SET
            status = 'resolved',

            resolution_action = $1,
            resolution_note = $2,

            resolved_at = NOW(),
            resolved_by = $3,

            reviewed_at =
              COALESCE(
                reviewed_at,
                NOW()
              ),

            reviewed_by =
              COALESCE(
                reviewed_by,
                $3
              )

          WHERE company_id = $4
            AND sync_item_id = $5
            AND conflict_type =
                'negative_stock'

            AND status IN (
              'open',
              'reviewed',
              'ignored'
            );
          `,
          [
            action,
            resolutionNote,
            auth.userId,

            auth.companyId,
            conflict.sync_item_id,
          ],
        )
      }

      const finalization = await finalizeResolvedSyncItem(
        client,

        auth.companyId,
        conflict.sync_item_id,

        auth.userId,
        action,
      )

      const conflictsResult = await client.query(
        `
          SELECT
            pc.*,

            reviewer.full_name
              AS reviewed_by_name,

            resolver.full_name
              AS resolved_by_name

          FROM pos_pending_conflicts pc

          LEFT JOIN users reviewer
            ON reviewer.id =
               pc.reviewed_by

          LEFT JOIN users resolver
            ON resolver.id =
               pc.resolved_by

          WHERE pc.company_id = $1
            AND pc.sync_item_id = $2

          ORDER BY pc.created_at ASC;
          `,
        [auth.companyId, conflict.sync_item_id],
      )

      await client.query('COMMIT')

      return res.json({
        data: {
          syncItemId: conflict.sync_item_id,

          saleId: conflict.server_entity_id,

          action,
          finalization,

          conflicts: conflictsResult.rows,
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      return next(error)
    } finally {
      client.release()
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

      const existingConflictResult = await db.query(
        `
    SELECT
      status,
      severity,
      conflict_type

    FROM pos_pending_conflicts

    WHERE company_id = $1
      AND id = $2

      AND (
        $3::uuid IS NULL
        OR branch_id =
           $3::uuid
      )

    LIMIT 1;
    `,
        [companyId.trim(), conflictId, selectedBranchId],
      )

      if ((existingConflictResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'POS sync conflict was not found',
        })
      }

      const existingConflict = existingConflictResult.rows[0]

      if (existingConflict.status === 'resolved') {
        return res.status(409).json({
          error: 'Resolved conflict cannot be reopened or changed',
        })
      }

      if (status === 'ignored' && existingConflict.severity === 'critical') {
        return res.status(409).json({
          error: 'Critical conflict cannot be ignored; it must be resolved',
        })
      }

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
