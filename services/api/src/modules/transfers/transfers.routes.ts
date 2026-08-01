import { Router } from 'express'
import { db } from '../../db/pool'
// الشركة والفرع والمستخدم يتم تحميلهم من Session الموثقة.
import { getAuthContext } from '../auth/auth.middleware'
export const transfersRouter = Router()

class TransferApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const transferUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const allowedTransferStatuses = new Set([
  'draft',
  'pending',
  'approved',
  'in_transit',
  'received',
  'cancelled',
])

function isTransferUuid(value: string) {
  return transferUuidPattern.test(value)
}

function isPostgresUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

function parseTransferLimit(value: unknown) {
  const numericValue = Number(value ?? 50)

  if (!Number.isFinite(numericValue)) {
    return 50
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

// تحويل كمية التحويل إلى رقم موجب بدقة ثلاث خانات.
// تستخدم في الطلب والاعتماد والشحن.
function parseTransferQuantity(value: unknown) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null
  }

  const roundedValue = Number(numericValue.toFixed(3))

  if (Math.abs(numericValue - roundedValue) > 0.0000001) {
    return null
  }

  if (roundedValue > 99_999_999_999.999) {
    return null
  }

  return roundedValue
}

// كمية الاستلام تسمح بصفر؛
// لأن الصنف قد لا يصل نهائيًا ويُسجل كعجز كامل.
function parseTransferReceivedQuantity(value: unknown) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null
  }

  const roundedValue = Number(numericValue.toFixed(3))

  if (Math.abs(numericValue - roundedValue) > 0.0000001) {
    return null
  }

  if (roundedValue > 99_999_999_999.999) {
    return null
  }

  return roundedValue
}

// ======================================================
// تحميل تحويل كامل مع أصنافه.
// ======================================================
async function loadTransferDetails(
  companyId: string,
  transferId: string,
  branchId: string | null,
) {
  const transferResult = await db.query(
    `
    SELECT
      t.*,

      from_location.name
        AS from_location_name,
      from_location.code
        AS from_location_code,

      to_location.name
        AS to_location_name,
      to_location.code
        AS to_location_code,

      from_branch.name
        AS from_branch_name,
      to_branch.name
        AS to_branch_name,

      requested_user.full_name
        AS requested_by_name,
      approved_user.full_name
        AS approved_by_name,
      received_user.full_name
        AS received_by_name,
      cancelled_user.full_name
        AS cancelled_by_name

    FROM transfers t

    JOIN stock_locations from_location
      ON from_location.id = t.from_location_id
      AND from_location.company_id = t.company_id

    JOIN stock_locations to_location
      ON to_location.id = t.to_location_id
      AND to_location.company_id = t.company_id

    LEFT JOIN branches from_branch
      ON from_branch.id = t.from_branch_id
      AND from_branch.company_id = t.company_id

    LEFT JOIN branches to_branch
      ON to_branch.id = t.to_branch_id
      AND to_branch.company_id = t.company_id

    LEFT JOIN users requested_user
      ON requested_user.id = t.requested_by
      AND requested_user.company_id = t.company_id

    LEFT JOIN users approved_user
      ON approved_user.id = t.approved_by
      AND approved_user.company_id = t.company_id

    LEFT JOIN users received_user
      ON received_user.id = t.received_by
      AND received_user.company_id = t.company_id

    LEFT JOIN users cancelled_user
      ON cancelled_user.id = t.cancelled_by
      AND cancelled_user.company_id = t.company_id

    WHERE t.company_id = $1
      AND t.id = $2

      AND (
        $3::uuid IS NULL
        OR t.from_branch_id = $3::uuid
        OR t.to_branch_id = $3::uuid
      )

    LIMIT 1;
    `,
    [companyId, transferId, branchId],
  )

  if ((transferResult.rowCount ?? 0) === 0) {
    return null
  }

  const itemsResult = await db.query(
    `
    SELECT
      ti.*,
      pv.sku,
      pv.primary_barcode,
      p.name AS product_name,
      fs.name AS size_name,
      fc.name AS color_name

    FROM transfer_items ti

    JOIN product_variants pv
      ON pv.id = ti.variant_id
      AND pv.company_id = ti.company_id

    JOIN products p
      ON p.id = pv.product_id
      AND p.company_id = pv.company_id

    LEFT JOIN fashion_sizes fs
      ON fs.id = pv.size_id
      AND fs.company_id = pv.company_id

    LEFT JOIN fashion_colors fc
      ON fc.id = pv.color_id
      AND fc.company_id = pv.company_id

    WHERE ti.company_id = $1
      AND ti.transfer_id = $2

    ORDER BY p.name ASC, pv.sku ASC;
    `,
    [companyId, transferId],
  )

  return {
    transfer: transferResult.rows[0],
    items: itemsResult.rows,
  }
}

async function loadTransferByIdempotency(
  companyId: string,
  idempotencyKey: string,
  branchId: string | null,
) {
  const result = await db.query(
    `
    SELECT id
    FROM transfers
    WHERE company_id = $1
      AND idempotency_key = $2
    LIMIT 1;
    `,
    [companyId, idempotencyKey],
  )

  if ((result.rowCount ?? 0) === 0) {
    return null
  }

  return loadTransferDetails(companyId, result.rows[0].id, branchId)
}

// ======================================================
// GET /api/transfers/locations
//
// يعرض أماكن المصدر والوجهة.
//
// can_send_from:
// يحدد الأماكن التي يستطيع المستخدم الحالي بدء
// تحويل صادر منها.
// ======================================================
transfersRouter.get('/api/transfers/locations', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    // لا نثق في أي companyId أو branchId قادم من الواجهة.
    const companyId = auth.companyId
    const authenticatedBranchId = auth.branchId

    const result = await db.query(
      `
        SELECT
          sl.id,
          sl.company_id,
          sl.branch_id,
          b.name AS branch_name,
          sl.code,
          sl.name,
          sl.location_type,

          CASE
            WHEN $2::uuid IS NULL THEN TRUE
            WHEN sl.branch_id = $2::uuid THEN TRUE
            ELSE FALSE
          END AS can_send_from

        FROM stock_locations sl

        LEFT JOIN branches b
          ON b.id = sl.branch_id
          AND b.company_id = sl.company_id

        WHERE sl.company_id = $1
          AND sl.is_active = TRUE

        ORDER BY
          CASE
            WHEN sl.branch_id = $2::uuid THEN 1
            WHEN sl.branch_id IS NULL THEN 2
            ELSE 3
          END,
          b.name ASC NULLS FIRST,
          sl.name ASC;
        `,
      [companyId, authenticatedBranchId],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/transfers/lookup-item
//
// بحث عن صنف داخل مكان المصدر بالباركود أو SKU.
// يعيد الرصيد الحالي قبل إضافته إلى التحويل.
// ======================================================
transfersRouter.get('/api/transfers/lookup-item', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const companyId = auth.companyId
    const authenticatedBranchId = auth.branchId

    const fromLocationId = req.query.fromLocationId
    const code = req.query.code

    if (
      typeof fromLocationId !== 'string' ||
      !isTransferUuid(fromLocationId.trim())
    ) {
      return res.status(400).json({
        error: 'fromLocationId is invalid',
      })
    }

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({
        error: 'code query parameter is required',
      })
    }

    const result = await db.query(
      `
        SELECT
          pv.id AS variant_id,
          p.name AS product_name,
          pv.sku,
          pv.primary_barcode,
          fs.name AS size_name,
          fc.name AS color_name,

          COALESCE(
            sb.quantity,
            0
          ) AS available_quantity,

          sl.id AS from_location_id,
          sl.name AS from_location_name,
          sl.code AS from_location_code

        FROM product_variants pv

        JOIN products p
          ON p.id = pv.product_id
          AND p.company_id = pv.company_id

        JOIN stock_locations sl
          ON sl.id = $2
          AND sl.company_id = pv.company_id
          AND sl.is_active = TRUE

        LEFT JOIN fashion_sizes fs
          ON fs.id = pv.size_id

        LEFT JOIN fashion_colors fc
          ON fc.id = pv.color_id

        LEFT JOIN variant_barcodes vb
          ON vb.variant_id = pv.id
          AND vb.company_id = pv.company_id

        LEFT JOIN stock_balances sb
          ON sb.company_id = pv.company_id
          AND sb.stock_location_id = sl.id
          AND sb.variant_id = pv.id

        WHERE pv.company_id = $1
          AND pv.status = 'active'

          -- مستخدم الفرع لا يرسل من مكان فرع آخر.
          AND (
            $4::uuid IS NULL
            OR sl.branch_id = $4::uuid
          )

          AND (
            pv.primary_barcode = $3
            OR pv.sku = $3
            OR vb.barcode = $3
          )

        LIMIT 1;
        `,
      [companyId, fromLocationId.trim(), code.trim(), authenticatedBranchId],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({
        error: 'الصنف غير موجود أو مكان المصدر غير مسموح.',
      })
    }

    return res.json({
      data: result.rows[0],
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/transfers
// ======================================================
transfersRouter.get('/api/transfers', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const companyId = auth.companyId
    const authenticatedBranchId = auth.branchId

    const status = req.query.status

    const selectedStatus =
      typeof status === 'string' && status.trim() ? status.trim() : null

    if (selectedStatus && !allowedTransferStatuses.has(selectedStatus)) {
      return res.status(400).json({
        error: 'Unsupported transfer status',
      })
    }

    const result = await db.query(
      `
        SELECT
          t.id,
          t.company_id,
          t.transfer_number,
          t.from_branch_id,
          from_branch.name
            AS from_branch_name,
          t.to_branch_id,
          to_branch.name
            AS to_branch_name,
          t.from_location_id,
          from_location.name
            AS from_location_name,
          from_location.code
            AS from_location_code,
          t.to_location_id,
          to_location.name
            AS to_location_name,
          to_location.code
            AS to_location_code,
          t.status,
          t.requested_at,
          t.approved_at,
          t.received_at,
          t.cancelled_at,
          t.cancellation_reason,

          t.has_receiving_discrepancy,
          t.receiving_note,

          t.note,
          t.created_at,

          COUNT(ti.id)::int
            AS items_count,

          COALESCE(
            SUM(ti.requested_quantity),
            0
          ) AS requested_quantity

        FROM transfers t

        JOIN stock_locations from_location
          ON from_location.id =
            t.from_location_id
          AND from_location.company_id =
            t.company_id

        JOIN stock_locations to_location
          ON to_location.id =
            t.to_location_id
          AND to_location.company_id =
            t.company_id

        LEFT JOIN branches from_branch
          ON from_branch.id =
            t.from_branch_id
          AND from_branch.company_id =
            t.company_id

        LEFT JOIN branches to_branch
          ON to_branch.id =
            t.to_branch_id
          AND to_branch.company_id =
            t.company_id

        LEFT JOIN transfer_items ti
          ON ti.transfer_id = t.id
          AND ti.company_id = t.company_id

        WHERE t.company_id = $1

          AND (
            $2::uuid IS NULL
            OR t.from_branch_id = $2::uuid
            OR t.to_branch_id = $2::uuid
          )

          AND (
            $3::text IS NULL
            OR t.status = $3::text
          )

        GROUP BY
          t.id,
          from_branch.name,
          to_branch.name,
          from_location.name,
          from_location.code,
          to_location.name,
          to_location.code

        ORDER BY t.created_at DESC
        LIMIT $4;
        `,
      [
        companyId,
        authenticatedBranchId,
        selectedStatus,
        parseTransferLimit(req.query.limit),
      ],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/transfers/:transferId
// ======================================================
transfersRouter.get('/api/transfers/:transferId', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const transferId = String(req.params.transferId || '').trim()

    if (!isTransferUuid(transferId)) {
      return res.status(400).json({
        error: 'transferId is invalid',
      })
    }

    // لا نستخدم أي Tenant IDs قادمة من Query String.
    const details = await loadTransferDetails(
      auth.companyId,
      transferId,
      auth.branchId,
    )

    if (!details) {
      return res.status(404).json({
        error: 'Transfer was not found',
      })
    }

    return res.json({
      data: details,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// POST /api/transfers
//
// ينشئ طلب تحويل Pending فقط.
// لا يخصم أو يضيف مخزون في هذه المرحلة.
// ======================================================
transfersRouter.post('/api/transfers', async (req, res, next) => {
  const auth = getAuthContext(res)
  const client = await db.connect()

  try {
    const {
      transferNumber,
      idempotencyKey,
      fromLocationId,
      toLocationId,
      note,
      items,
    } = req.body

    // القيم الحساسة تأتي من Session فقط.
    const companyId = auth.companyId
    const authenticatedBranchId = auth.branchId
    const createdBy = auth.userId

    if (typeof transferNumber !== 'string' || !transferNumber.trim()) {
      return res.status(400).json({
        error: 'transferNumber is required',
      })
    }

    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return res.status(400).json({
        error: 'idempotencyKey is required',
      })
    }

    if (
      typeof fromLocationId !== 'string' ||
      !isTransferUuid(fromLocationId.trim())
    ) {
      return res.status(400).json({
        error: 'fromLocationId is invalid',
      })
    }

    if (
      typeof toLocationId !== 'string' ||
      !isTransferUuid(toLocationId.trim())
    ) {
      return res.status(400).json({
        error: 'toLocationId is invalid',
      })
    }

    if (fromLocationId.trim() === toLocationId.trim()) {
      return res.status(400).json({
        error: 'Source and destination must be different',
      })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'items are required',
      })
    }

    const existingTransfer = await loadTransferByIdempotency(
      companyId,
      idempotencyKey.trim(),
      authenticatedBranchId,
    )

    if (existingTransfer) {
      return res.status(200).json({
        duplicated: true,
        data: existingTransfer,
      })
    }

    const normalizedItems: Array<{
      variantId: string
      quantity: number
      note: string | null
    }> = []

    const variantIds = new Set<string>()

    for (const item of items) {
      const variantId =
        typeof item?.variantId === 'string' ? item.variantId.trim() : ''

      const quantity = Number(item?.quantity)

      if (!isTransferUuid(variantId)) {
        throw new TransferApiError(
          400,
          'variantId is invalid for one or more items',
        )
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new TransferApiError(
          400,
          'Transfer quantity must be greater than zero',
        )
      }

      if (variantIds.has(variantId)) {
        throw new TransferApiError(400, 'Duplicate variant inside transfer')
      }

      variantIds.add(variantId)

      normalizedItems.push({
        variantId,
        quantity,
        note:
          typeof item?.note === 'string' && item.note.trim()
            ? item.note.trim()
            : null,
      })
    }

    await client.query('BEGIN')

    const locationsResult = await client.query(
      `
          SELECT
            id,
            branch_id,
            name,
            code
          FROM stock_locations
          WHERE company_id = $1
            AND id = ANY($2::uuid[])
            AND is_active = TRUE
          FOR SHARE;
          `,
      [companyId, [fromLocationId.trim(), toLocationId.trim()]],
    )

    if ((locationsResult.rowCount ?? 0) !== 2) {
      throw new TransferApiError(
        404,
        'Source or destination location was not found',
      )
    }

    const fromLocation = locationsResult.rows.find(
      (location) => location.id === fromLocationId.trim(),
    )

    const toLocation = locationsResult.rows.find(
      (location) => location.id === toLocationId.trim(),
    )

    if (!fromLocation || !toLocation) {
      throw new TransferApiError(404, 'Transfer locations were not found')
    }

    if (
      authenticatedBranchId &&
      fromLocation.branch_id !== authenticatedBranchId
    ) {
      throw new TransferApiError(
        403,
        'You cannot send stock from another branch',
      )
    }

    const activeVariantsResult = await client.query(
      `
          SELECT id
          FROM product_variants
          WHERE company_id = $1
            AND id = ANY($2::uuid[])
            AND status = 'active';
          `,
      [companyId, Array.from(variantIds)],
    )

    if ((activeVariantsResult.rowCount ?? 0) !== normalizedItems.length) {
      throw new TransferApiError(
        404,
        'One or more transfer items were not found or inactive',
      )
    }

    const transferResult = await client.query(
      `
          INSERT INTO transfers (
            company_id,
            transfer_number,
            idempotency_key,
            from_branch_id,
            to_branch_id,
            from_location_id,
            to_location_id,
            status,
            requested_by,
            requested_at,
            note,
            updated_at
          )
          VALUES (
            $1, $2, $3,
            $4, $5,
            $6, $7,
            'pending',
            $8,
            NOW(),
            $9,
            NOW()
          )
          RETURNING *;
          `,
      [
        companyId,
        transferNumber.trim(),
        idempotencyKey.trim(),
        fromLocation.branch_id,
        toLocation.branch_id,
        fromLocationId.trim(),
        toLocationId.trim(),
        createdBy,
        typeof note === 'string' && note.trim() ? note.trim() : null,
      ],
    )

    const createdTransfer = transferResult.rows[0]

    const createdItems = []

    for (const item of normalizedItems) {
      const itemResult = await client.query(
        `
            INSERT INTO transfer_items (
              company_id,
              transfer_id,
              variant_id,
              requested_quantity,
              note
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
            `,
        [
          companyId,
          createdTransfer.id,
          item.variantId,
          item.quantity,
          item.note,
        ],
      )

      createdItems.push(itemResult.rows[0])
    }

    await client.query('COMMIT')

    const details = await loadTransferDetails(
      companyId,
      createdTransfer.id,
      authenticatedBranchId,
    )

    return res.status(201).json({
      data: details || {
        transfer: createdTransfer,
        items: createdItems,
      },
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    if (isPostgresUniqueViolation(error)) {
      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      if (idempotencyKey) {
        // معالجة التكرار تستخدم نفس Session ولا تثق في الـBody.
        const existingTransfer = await loadTransferByIdempotency(
          auth.companyId,
          idempotencyKey,
          auth.branchId,
        )

        if (existingTransfer) {
          return res.status(200).json({
            duplicated: true,
            data: existingTransfer,
          })
        }
      }

      return res.status(409).json({
        error: 'Transfer number already exists',
      })
    }

    return next(error)
  } finally {
    client.release()
  }
})

// ======================================================
// POST /api/transfers/:transferId/cancel
//
// يلغي التحويل قبل الشحن فقط.
//
// لا يتم تعديل stock_balances لأن التحويل في حالة
// pending أو approved لم يخصم المخزون حتى الآن.
//
// صلاحية هذا الـEndpoint هي inventory.transfer.create
// حسب سياسة صلاحيات التحويلات الحالية.
// ======================================================
transfersRouter.post(
  '/api/transfers/:transferId/cancel',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const transferId = String(req.params.transferId || '')
        .trim()
        .toLowerCase()

      if (!isTransferUuid(transferId)) {
        return res.status(400).json({
          error: 'transferId is invalid',
        })
      }

      const cancellationReason =
        typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''

      if (cancellationReason.length < 3 || cancellationReason.length > 300) {
        return res.status(400).json({
          error: 'سبب الإلغاء يجب أن يكون بين 3 و300 حرف.',
        })
      }

      await client.query('BEGIN')

      // قفل التحويل يمنع شحنه وإلغاءه في نفس اللحظة.
      const transferResult = await client.query(
        `
          SELECT
            transfer.*

          FROM transfers transfer

          JOIN stock_locations from_location
            ON from_location.company_id =
               transfer.company_id

            AND from_location.id =
                transfer.from_location_id

          WHERE transfer.company_id = $1
            AND transfer.id = $2

            -- مستخدم الفرع يلغي التحويلات الصادرة
            -- من فرعه فقط.
            AND (
              $3::uuid IS NULL
              OR transfer.from_branch_id = $3
            )

          FOR UPDATE OF transfer;
        `,
        [auth.companyId, transferId, auth.branchId],
      )

      if ((transferResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(
          404,
          'التحويل غير موجود أو غير مسموح بإلغائه.',
        )
      }

      const transfer = transferResult.rows[0]

      // إعادة نفس طلب الإلغاء آمنة ولا تنشئ Audit جديدًا.
      if (transfer.status === 'cancelled') {
        await client.query('COMMIT')

        const details = await loadTransferDetails(
          auth.companyId,
          transferId,
          auth.branchId,
        )

        return res.status(200).json({
          duplicated: true,
          data: details,
        })
      }

      // بعد الشحن يكون المخزون خُصم من المصدر،
      // لذلك لا يجوز استخدام الإلغاء العادي.
      if (transfer.status === 'in_transit' || transfer.status === 'received') {
        throw new TransferApiError(409, 'لا يمكن إلغاء التحويل بعد شحنه.')
      }

      if (!['draft', 'pending', 'approved'].includes(transfer.status)) {
        throw new TransferApiError(
          409,
          `لا يمكن إلغاء التحويل من الحالة: ${transfer.status}`,
        )
      }

      const cancelledResult = await client.query(
        `
          UPDATE transfers

          SET
            status = 'cancelled',
            cancelled_by = $1,
            cancelled_at = NOW(),
            cancellation_reason = $2,
            updated_at = NOW()

          WHERE company_id = $3
            AND id = $4

          RETURNING *;
        `,
        [auth.userId, cancellationReason, auth.companyId, transferId],
      )

      const cancelledTransfer = cancelledResult.rows[0]

      // نسجل الإلغاء داخل Audit Log في نفس Transaction.
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
            'inventory.transfer.cancelled',
            'transfer',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          transfer.from_branch_id,
          auth.userId,

          transferId,

          JSON.stringify({
            status: transfer.status,
          }),

          JSON.stringify({
            status: 'cancelled',
            reason: cancellationReason,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      const details = await loadTransferDetails(
        auth.companyId,
        transferId,
        auth.branchId,
      )

      return res.json({
        duplicated: false,

        data: details || {
          transfer: cancelledTransfer,
          items: [],
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof TransferApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// POST /api/transfers/:transferId/approve
//
// يعتمد التحويل والكميات قبل الشحن.
//
// الاعتماد لا يغيّر stock_balances ولا ينشئ حركات مخزون.
// الخصم يتم لاحقًا عند تنفيذ /ship.
// ======================================================
transfersRouter.post(
  '/api/transfers/:transferId/approve',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const transferId = String(req.params.transferId || '')
        .trim()
        .toLowerCase()

      if (!isTransferUuid(transferId)) {
        return res.status(400).json({
          error: 'transferId is invalid',
        })
      }

      if (!Array.isArray(req.body?.items) || req.body.items.length === 0) {
        return res.status(400).json({
          error: 'Approval items are required',
        })
      }

      const approvedItems: Array<{
        itemId: string
        approvedQuantity: number
      }> = []

      const itemIds = new Set<string>()

      for (const item of req.body.items) {
        const itemId =
          typeof item?.itemId === 'string'
            ? item.itemId.trim().toLowerCase()
            : ''

        const approvedQuantity = parseTransferQuantity(item?.approvedQuantity)

        if (!isTransferUuid(itemId)) {
          throw new TransferApiError(
            400,
            'itemId is invalid for one or more items',
          )
        }

        if (approvedQuantity === null) {
          throw new TransferApiError(
            400,
            'الكمية المعتمدة يجب أن تكون أكبر من صفر وبدقة 3 خانات.',
          )
        }

        if (itemIds.has(itemId)) {
          throw new TransferApiError(
            400,
            'Duplicate transfer item inside approval',
          )
        }

        itemIds.add(itemId)

        approvedItems.push({
          itemId,
          approvedQuantity,
        })
      }

      await client.query('BEGIN')

      // قفل رأس التحويل يمنع اعتماده أو إلغائه أو شحنه
      // في نفس اللحظة من طلبات مختلفة.
      const transferResult = await client.query(
        `
          SELECT
            transfer.*

          FROM transfers transfer

          JOIN stock_locations from_location
            ON from_location.company_id =
               transfer.company_id

            AND from_location.id =
                transfer.from_location_id

          WHERE transfer.company_id = $1
            AND transfer.id = $2

            -- مستخدم الفرع يعتمد تحويلات فرعه الصادرة فقط.
            AND (
              $3::uuid IS NULL
              OR transfer.from_branch_id = $3
            )

          FOR UPDATE OF transfer;
        `,
        [auth.companyId, transferId, auth.branchId],
      )

      if ((transferResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(
          404,
          'التحويل غير موجود أو غير مسموح باعتماده.',
        )
      }

      const transfer = transferResult.rows[0]

      // إعادة طلب الاعتماد بعد نجاحه آمنة.
      if (
        transfer.status === 'approved' ||
        transfer.status === 'in_transit' ||
        transfer.status === 'received'
      ) {
        await client.query('COMMIT')

        const details = await loadTransferDetails(
          auth.companyId,
          transferId,
          auth.branchId,
        )

        return res.status(200).json({
          duplicated: true,
          data: details,
        })
      }

      if (transfer.status === 'cancelled') {
        throw new TransferApiError(409, 'لا يمكن اعتماد تحويل ملغي.')
      }

      if (transfer.status !== 'pending') {
        throw new TransferApiError(
          409,
          `لا يمكن اعتماد التحويل من الحالة: ${transfer.status}`,
        )
      }

      const transferItemsResult = await client.query(
        `
          SELECT
            id,
            requested_quantity

          FROM transfer_items

          WHERE company_id = $1
            AND transfer_id = $2

          ORDER BY id

          FOR UPDATE;
        `,
        [auth.companyId, transferId],
      )

      if ((transferItemsResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(409, 'التحويل لا يحتوي على أصناف.')
      }

      // يجب إرسال كل أصناف التحويل في طلب الاعتماد.
      if (transferItemsResult.rows.length !== approvedItems.length) {
        throw new TransferApiError(
          400,
          'يجب تحديد الكمية المعتمدة لكل أصناف التحويل.',
        )
      }

      let requestedTotal = 0
      let approvedTotal = 0

      for (const transferItem of transferItemsResult.rows) {
        const approvedItem = approvedItems.find(
          (item) => item.itemId === transferItem.id,
        )

        if (!approvedItem) {
          throw new TransferApiError(
            400,
            'يوجد صنف في التحويل لم يتم إرسال كميته المعتمدة.',
          )
        }

        const requestedQuantity = Number(transferItem.requested_quantity)

        if (approvedItem.approvedQuantity > requestedQuantity) {
          throw new TransferApiError(
            400,
            'الكمية المعتمدة لا يمكن أن تتجاوز الكمية المطلوبة.',
          )
        }

        requestedTotal += requestedQuantity
        approvedTotal += approvedItem.approvedQuantity

        await client.query(
          `
            UPDATE transfer_items

            SET approved_quantity = $1

            WHERE company_id = $2
              AND transfer_id = $3
              AND id = $4;
          `,
          [
            approvedItem.approvedQuantity,
            auth.companyId,
            transferId,
            transferItem.id,
          ],
        )
      }

      const approvedResult = await client.query(
        `
          UPDATE transfers

          SET
            status = 'approved',
            approved_by = $1,
            approved_at = NOW(),
            updated_at = NOW()

          WHERE company_id = $2
            AND id = $3

          RETURNING *;
        `,
        [auth.userId, auth.companyId, transferId],
      )

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
            'inventory.transfer.approved',
            'transfer',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          transfer.from_branch_id,
          auth.userId,

          transferId,

          JSON.stringify({
            status: 'pending',
            requestedTotal,
          }),

          JSON.stringify({
            status: 'approved',
            approvedTotal,
            itemCount: approvedItems.length,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      const details = await loadTransferDetails(
        auth.companyId,
        transferId,
        auth.branchId,
      )

      return res.json({
        duplicated: false,

        data: details || {
          transfer: approvedResult.rows[0],
          items: [],
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof TransferApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// POST /api/transfers/:transferId/ship
//
// يخصم الكميات من مكان المصدر ويحوّل الحالة إلى
// in_transit.
// ======================================================
transfersRouter.post(
  '/api/transfers/:transferId/ship',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const transferId = String(req.params.transferId || '').trim()

      if (!isTransferUuid(transferId)) {
        return res.status(400).json({
          error: 'transferId is invalid',
        })
      }

      // منفذ الشحن والشركة والفرع يأتون من Session.
      const companyId = auth.companyId
      const authenticatedBranchId = auth.branchId
      const createdBy = auth.userId

      await client.query('BEGIN')

      const transferResult = await client.query(
        `
          SELECT t.*
          FROM transfers t

          JOIN stock_locations from_location
            ON from_location.id =
              t.from_location_id
            AND from_location.company_id =
              t.company_id
            AND from_location.is_active = TRUE

          JOIN stock_locations to_location
            ON to_location.id =
              t.to_location_id
            AND to_location.company_id =
              t.company_id
            AND to_location.is_active = TRUE

          WHERE t.company_id = $1
            AND t.id = $2

            AND (
              $3::uuid IS NULL
              OR t.from_branch_id =
                $3::uuid
            )

          FOR UPDATE OF t;
          `,
        [companyId, transferId, authenticatedBranchId],
      )

      if ((transferResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(
          404,
          'Transfer was not found or cannot be shipped by this branch',
        )
      }

      const transfer = transferResult.rows[0]

      if (transfer.status === 'in_transit' || transfer.status === 'received') {
        await client.query('COMMIT')

        const details = await loadTransferDetails(
          companyId,
          transferId,
          authenticatedBranchId,
        )

        return res.status(200).json({
          duplicated: true,
          data: details,
        })
      }

      // الشحن لا يتم إلا بعد اعتماد الكميات.
      if (transfer.status !== 'approved') {
        throw new TransferApiError(
          409,
          `Transfer cannot be shipped from status: ${transfer.status}`,
        )
      }

      const itemsResult = await client.query(
        `
        SELECT *
        FROM transfer_items
        WHERE company_id = $1
          AND transfer_id = $2
        ORDER BY variant_id ASC;
        `,
        [companyId, transferId],
      )

      if ((itemsResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(400, 'Transfer has no items')
      }

      for (const item of itemsResult.rows) {
        // الكمية المشحونة هي الكمية التي اعتمدها المسؤول.
        const transferQuantity = Number(item.approved_quantity)

        if (!Number.isFinite(transferQuantity) || transferQuantity <= 0) {
          throw new TransferApiError(
            400,
            'Approved transfer quantity is invalid',
          )
        }

        const balanceResult = await client.query(
          `
            SELECT quantity
            FROM stock_balances
            WHERE company_id = $1
              AND stock_location_id = $2
              AND variant_id = $3
            FOR UPDATE;
            `,
          [companyId, transfer.from_location_id, item.variant_id],
        )

        if ((balanceResult.rowCount ?? 0) === 0) {
          throw new TransferApiError(409, 'Source stock balance was not found')
        }

        const quantityBefore = Number(balanceResult.rows[0].quantity)

        if (quantityBefore < transferQuantity) {
          throw new TransferApiError(
            409,
            `Insufficient stock for variant ${item.variant_id}`,
          )
        }

        const quantityAfter = quantityBefore - transferQuantity

        await client.query(
          `
          UPDATE stock_balances
          SET
            quantity = $1,
            updated_at = NOW()
          WHERE company_id = $2
            AND stock_location_id = $3
            AND variant_id = $4;
          `,
          [
            quantityAfter,
            companyId,
            transfer.from_location_id,
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
            'transfer_out',
            $5, $6, $7,
            'transfer',
            $8,
            $9,
            $10
          );
          `,
          [
            companyId,
            transfer.from_branch_id,
            transfer.from_location_id,
            item.variant_id,
            -transferQuantity,
            quantityBefore,
            quantityAfter,
            transfer.id,
            `Transfer ${transfer.transfer_number} shipped`,
            createdBy,
          ],
        )
      }

      const updatedTransferResult = await client.query(
        `
          UPDATE transfers

          SET
            status = 'in_transit',
            updated_at = NOW()

          WHERE company_id = $1
            AND id = $2

          RETURNING *;
        `,
        [companyId, transferId],
      )

      await client.query('COMMIT')

      const details = await loadTransferDetails(
        companyId,
        transferId,
        authenticatedBranchId,
      )

      return res.json({
        data: details || {
          transfer: updatedTransferResult.rows[0],
          items: [],
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof TransferApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// POST /api/transfers/:transferId/receive
//
// يسجل الكميات التي وصلت فعليًا إلى الوجهة.
//
// الكمية المستلمة قد تكون أقل من المعتمدة، لكن لا يمكن
// أن تتجاوز الكمية التي خرجت من مكان المصدر.
//
// أي فرق يتطلب ملاحظة توضح سبب العجز.
// ======================================================
transfersRouter.post(
  '/api/transfers/:transferId/receive',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const transferId = String(req.params.transferId || '')
        .trim()
        .toLowerCase()

      if (!isTransferUuid(transferId)) {
        return res.status(400).json({
          error: 'transferId is invalid',
        })
      }

      const receivingNote =
        typeof req.body?.note === 'string' ? req.body.note.trim() : ''

      if (receivingNote.length > 500) {
        return res.status(400).json({
          error: 'ملاحظة الاستلام لا يمكن أن تتجاوز 500 حرف.',
        })
      }

      await client.query('BEGIN')

      // قفل التحويل يمنع تنفيذ استلامين متزامنين
      // أو محاولة استلام التحويل أثناء تغيير حالته.
      const transferResult = await client.query(
        `
          SELECT
            transfer.*

          FROM transfers transfer

          JOIN stock_locations to_location
            ON to_location.company_id =
               transfer.company_id

            AND to_location.id =
                transfer.to_location_id

            AND to_location.is_active = TRUE

          WHERE transfer.company_id = $1
            AND transfer.id = $2

            -- مستخدم الفرع يستلم تحويلات فرعه
            -- الواردة فقط.
            AND (
              $3::uuid IS NULL
              OR transfer.to_branch_id = $3
            )

          FOR UPDATE OF transfer;
        `,
        [auth.companyId, transferId, auth.branchId],
      )

      if ((transferResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(
          404,
          'التحويل غير موجود أو غير مسموح باستلامه.',
        )
      }

      const transfer = transferResult.rows[0]

      // إعادة إرسال طلب الاستلام بعد نجاحه آمنة
      // ولا تضيف المخزون مرة أخرى.
      if (transfer.status === 'received') {
        await client.query('COMMIT')

        const details = await loadTransferDetails(
          auth.companyId,
          transferId,
          auth.branchId,
        )

        return res.status(200).json({
          duplicated: true,
          data: details,
        })
      }

      if (transfer.status !== 'in_transit') {
        throw new TransferApiError(
          409,
          `لا يمكن استلام التحويل من الحالة: ${transfer.status}`,
        )
      }

      if (!Array.isArray(req.body?.items) || req.body.items.length === 0) {
        throw new TransferApiError(
          400,
          'يجب إرسال الكميات المستلمة لكل أصناف التحويل.',
        )
      }

      const receivedItems: Array<{
        itemId: string
        receivedQuantity: number
      }> = []

      const receivedItemIds = new Set<string>()

      for (const item of req.body.items) {
        const itemId =
          typeof item?.itemId === 'string'
            ? item.itemId.trim().toLowerCase()
            : ''

        const receivedQuantity = parseTransferReceivedQuantity(
          item?.receivedQuantity,
        )

        if (!isTransferUuid(itemId)) {
          throw new TransferApiError(
            400,
            'يوجد itemId غير صالح في بيانات الاستلام.',
          )
        }

        if (receivedQuantity === null) {
          throw new TransferApiError(
            400,
            'الكمية المستلمة يجب أن تكون صفرًا أو أكبر وبدقة 3 خانات.',
          )
        }

        if (receivedItemIds.has(itemId)) {
          throw new TransferApiError(
            400,
            'تم إرسال نفس صنف التحويل أكثر من مرة.',
          )
        }

        receivedItemIds.add(itemId)

        receivedItems.push({
          itemId,
          receivedQuantity,
        })
      }

      const transferItemsResult = await client.query(
        `
          SELECT
            id,
            variant_id,
            approved_quantity,
            received_quantity

          FROM transfer_items

          WHERE company_id = $1
            AND transfer_id = $2

          ORDER BY variant_id, id

          FOR UPDATE;
        `,
        [auth.companyId, transferId],
      )

      if ((transferItemsResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(409, 'التحويل لا يحتوي على أصناف.')
      }

      if (transferItemsResult.rows.length !== receivedItems.length) {
        throw new TransferApiError(
          400,
          'يجب تسجيل الكمية المستلمة لكل أصناف التحويل.',
        )
      }

      const resolvedItems: Array<{
        itemId: string
        variantId: string
        approvedQuantity: number
        receivedQuantity: number
        shortageQuantity: number
        hasDiscrepancy: boolean
      }> = []

      let approvedTotal = 0
      let receivedTotal = 0
      let shortageTotal = 0
      let discrepancyItemCount = 0

      for (const transferItem of transferItemsResult.rows) {
        const receivedItem = receivedItems.find(
          (item) => item.itemId === transferItem.id,
        )

        if (!receivedItem) {
          throw new TransferApiError(
            400,
            'يوجد صنف لم يتم تسجيل كميته المستلمة.',
          )
        }

        const approvedQuantity = Number(transferItem.approved_quantity)

        if (!Number.isFinite(approvedQuantity) || approvedQuantity <= 0) {
          throw new TransferApiError(
            409,
            'يوجد صنف لم يتم اعتماد كميته بشكل صحيح.',
          )
        }

        if (receivedItem.receivedQuantity > approvedQuantity) {
          throw new TransferApiError(
            400,
            'الكمية المستلمة لا يمكن أن تتجاوز الكمية المشحونة.',
          )
        }

        const shortageQuantity = Number(
          (approvedQuantity - receivedItem.receivedQuantity).toFixed(3),
        )

        const hasDiscrepancy = shortageQuantity > 0

        approvedTotal += approvedQuantity
        receivedTotal += receivedItem.receivedQuantity

        shortageTotal += shortageQuantity

        if (hasDiscrepancy) {
          discrepancyItemCount += 1
        }

        resolvedItems.push({
          itemId: transferItem.id,
          variantId: transferItem.variant_id,
          approvedQuantity,
          receivedQuantity: receivedItem.receivedQuantity,
          shortageQuantity,
          hasDiscrepancy,
        })
      }

      const hasReceivingDiscrepancy = discrepancyItemCount > 0

      if (hasReceivingDiscrepancy && receivingNote.length < 3) {
        throw new TransferApiError(400, 'اكتب ملاحظة توضح سبب فرق الاستلام.')
      }

      let movementCount = 0

      for (const item of resolvedItems) {
        // الكمية صفر تعني أن الصنف لم يصل.
        // لا نغير الرصيد ولا ننشئ حركة كمية صفرية.
        if (item.receivedQuantity > 0) {
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
              transfer.to_branch_id,
              transfer.to_location_id,
              item.variantId,
            ],
          )

          const balanceResult = await client.query(
            `
              SELECT
                quantity

              FROM stock_balances

              WHERE company_id = $1
                AND stock_location_id = $2
                AND variant_id = $3

              FOR UPDATE;
            `,
            [auth.companyId, transfer.to_location_id, item.variantId],
          )

          if ((balanceResult.rowCount ?? 0) === 0) {
            throw new TransferApiError(
              500,
              'تعذر إنشاء رصيد الصنف في مكان الوجهة.',
            )
          }

          const quantityBefore = Number(balanceResult.rows[0].quantity)

          const quantityAfter = Number(
            (quantityBefore + item.receivedQuantity).toFixed(3),
          )

          await client.query(
            `
              UPDATE stock_balances

              SET
                quantity = $1,
                branch_id = $2,
                updated_at = NOW()

              WHERE company_id = $3
                AND stock_location_id = $4
                AND variant_id = $5;
            `,
            [
              quantityAfter,
              transfer.to_branch_id,
              auth.companyId,
              transfer.to_location_id,
              item.variantId,
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
                'transfer_in',
                $5, $6, $7,
                'transfer',
                $8,
                $9,
                $10
              );
            `,
            [
              auth.companyId,
              transfer.to_branch_id,
              transfer.to_location_id,
              item.variantId,

              item.receivedQuantity,
              quantityBefore,
              quantityAfter,

              transfer.id,

              `Transfer ${transfer.transfer_number} received`,

              auth.userId,
            ],
          )

          movementCount += 1
        }

        // نحفظ الكمية الفعلية حتى لو كانت صفرًا.
        await client.query(
          `
            UPDATE transfer_items

            SET received_quantity = $1

            WHERE company_id = $2
              AND transfer_id = $3
              AND id = $4;
          `,
          [item.receivedQuantity, auth.companyId, transferId, item.itemId],
        )
      }

      const updatedTransferResult = await client.query(
        `
          UPDATE transfers

          SET
            status = 'received',
            received_by = $1,
            received_at = NOW(),

            has_receiving_discrepancy = $2,
            receiving_note = $3,

            updated_at = NOW()

          WHERE company_id = $4
            AND id = $5

          RETURNING *;
        `,
        [
          auth.userId,
          hasReceivingDiscrepancy,
          receivingNote || null,
          auth.companyId,
          transferId,
        ],
      )

      // تسجيل ملخص الاستلام والفروق في Audit Log.
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
            'inventory.transfer.received',
            'transfer',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          transfer.to_branch_id,
          auth.userId,

          transferId,

          JSON.stringify({
            status: 'in_transit',
            approvedTotal,
          }),

          JSON.stringify({
            status: 'received',
            receivedTotal,
            shortageTotal,
            discrepancyItemCount,
            hasReceivingDiscrepancy,
            movementCount,
            receivingNote: receivingNote || null,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      const details = await loadTransferDetails(
        auth.companyId,
        transferId,
        auth.branchId,
      )

      return res.json({
        duplicated: false,

        data: details || {
          transfer: updatedTransferResult.rows[0],
          items: [],
        },

        summary: {
          approvedTotal,
          receivedTotal,
          shortageTotal,
          discrepancyItemCount,
          movementCount,
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof TransferApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)
