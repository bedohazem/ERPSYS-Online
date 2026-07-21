import { Router } from 'express'
import { db } from '../../db/pool'

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
        AS received_by_name

    FROM transfers t

    JOIN stock_locations from_location
      ON from_location.id = t.from_location_id
      AND from_location.company_id = t.company_id

    JOIN stock_locations to_location
      ON to_location.id = t.to_location_id
      AND to_location.company_id = t.company_id

    LEFT JOIN branches from_branch
      ON from_branch.id = t.from_branch_id

    LEFT JOIN branches to_branch
      ON to_branch.id = t.to_branch_id

    LEFT JOIN users requested_user
      ON requested_user.id = t.requested_by

    LEFT JOIN users approved_user
      ON approved_user.id = t.approved_by

    LEFT JOIN users received_user
      ON received_user.id = t.received_by

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

    LEFT JOIN fashion_colors fc
      ON fc.id = pv.color_id

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
// GET /api/transfers
// ======================================================
transfersRouter.get('/api/transfers', async (req, res, next) => {
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

        JOIN stock_locations to_location
          ON to_location.id =
            t.to_location_id

        LEFT JOIN branches from_branch
          ON from_branch.id =
            t.from_branch_id

        LEFT JOIN branches to_branch
          ON to_branch.id =
            t.to_branch_id

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
        companyId.trim(),
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
    const transferId = String(req.params.transferId || '').trim()

    const companyId = req.query.companyId
    const branchId = req.query.branchId

    if (!isTransferUuid(transferId)) {
      return res.status(400).json({
        error: 'transferId is invalid',
      })
    }

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    const authenticatedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const details = await loadTransferDetails(
      companyId.trim(),
      transferId,
      authenticatedBranchId,
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
  const client = await db.connect()

  try {
    const {
      companyId,
      branchId,
      transferNumber,
      idempotencyKey,
      fromLocationId,
      toLocationId,
      note,
      createdBy,
      items,
    } = req.body

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId is required',
      })
    }

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

    const authenticatedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const existingTransfer = await loadTransferByIdempotency(
      companyId.trim(),
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
      [companyId.trim(), [fromLocationId.trim(), toLocationId.trim()]],
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
      [companyId.trim(), Array.from(variantIds)],
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
        companyId.trim(),
        transferNumber.trim(),
        idempotencyKey.trim(),
        fromLocation.branch_id,
        toLocation.branch_id,
        fromLocationId.trim(),
        toLocationId.trim(),
        createdBy || null,
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
          companyId.trim(),
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
      companyId.trim(),
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
      const companyId =
        typeof req.body?.companyId === 'string' ? req.body.companyId.trim() : ''

      const branchId =
        typeof req.body?.branchId === 'string' && req.body.branchId.trim()
          ? req.body.branchId.trim()
          : null

      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      if (companyId && idempotencyKey) {
        const existingTransfer = await loadTransferByIdempotency(
          companyId,
          idempotencyKey,
          branchId,
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

    if (error instanceof TransferApiError) {
      return res.status(error.statusCode).json({
        error: error.message,
      })
    }

    return next(error)
  } finally {
    client.release()
  }
})

// ======================================================
// POST /api/transfers/:transferId/ship
//
// يخصم الكميات من مكان المصدر ويحوّل الحالة إلى
// in_transit.
// ======================================================
transfersRouter.post(
  '/api/transfers/:transferId/ship',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const transferId = String(req.params.transferId || '').trim()

      const { companyId, branchId, createdBy } = req.body

      if (!isTransferUuid(transferId)) {
        return res.status(400).json({
          error: 'transferId is invalid',
        })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      const authenticatedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

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
        [companyId.trim(), transferId, authenticatedBranchId],
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
          companyId.trim(),
          transferId,
          authenticatedBranchId,
        )

        return res.status(200).json({
          duplicated: true,
          data: details,
        })
      }

      if (transfer.status !== 'pending' && transfer.status !== 'approved') {
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
        [companyId.trim(), transferId],
      )

      if ((itemsResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(400, 'Transfer has no items')
      }

      for (const item of itemsResult.rows) {
        const transferQuantity = Number(
          item.approved_quantity ?? item.requested_quantity,
        )

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
          [companyId.trim(), transfer.from_location_id, item.variant_id],
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
            companyId.trim(),
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
            companyId.trim(),
            transfer.from_branch_id,
            transfer.from_location_id,
            item.variant_id,
            -transferQuantity,
            quantityBefore,
            quantityAfter,
            transfer.id,
            `Transfer ${transfer.transfer_number} shipped`,
            createdBy || null,
          ],
        )

        await client.query(
          `
          UPDATE transfer_items
          SET approved_quantity = $1
          WHERE company_id = $2
            AND transfer_id = $3
            AND id = $4;
          `,
          [transferQuantity, companyId.trim(), transferId, item.id],
        )
      }

      const updatedTransferResult = await client.query(
        `
          UPDATE transfers
          SET
            status = 'in_transit',
            approved_by = $1,
            approved_at = NOW(),
            updated_at = NOW()
          WHERE company_id = $2
            AND id = $3
          RETURNING *;
          `,
        [createdBy || null, companyId.trim(), transferId],
      )

      await client.query('COMMIT')

      const details = await loadTransferDetails(
        companyId.trim(),
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
// يزيد مكان الوجهة ويحوّل الحالة إلى received.
// ======================================================
transfersRouter.post(
  '/api/transfers/:transferId/receive',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const transferId = String(req.params.transferId || '').trim()

      const { companyId, branchId, createdBy } = req.body

      if (!isTransferUuid(transferId)) {
        return res.status(400).json({
          error: 'transferId is invalid',
        })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      const authenticatedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

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
              OR t.to_branch_id = $3::uuid
            )

          FOR UPDATE OF t;
          `,
        [companyId.trim(), transferId, authenticatedBranchId],
      )

      if ((transferResult.rowCount ?? 0) === 0) {
        throw new TransferApiError(
          404,
          'Transfer was not found or cannot be received by this branch',
        )
      }

      const transfer = transferResult.rows[0]

      if (transfer.status === 'received') {
        await client.query('COMMIT')

        const details = await loadTransferDetails(
          companyId.trim(),
          transferId,
          authenticatedBranchId,
        )

        return res.status(200).json({
          duplicated: true,
          data: details,
        })
      }

      if (transfer.status !== 'in_transit') {
        throw new TransferApiError(
          409,
          `Transfer cannot be received from status: ${transfer.status}`,
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
        [companyId.trim(), transferId],
      )

      for (const item of itemsResult.rows) {
        const receivedQuantity = Number(item.approved_quantity)

        if (!Number.isFinite(receivedQuantity) || receivedQuantity <= 0) {
          throw new TransferApiError(
            400,
            'Received transfer quantity is invalid',
          )
        }

        await client.query(
          `
          INSERT INTO stock_balances (
            company_id,
            branch_id,
            stock_location_id,
            variant_id,
            quantity
          )
          VALUES ($1, $2, $3, $4, 0)

          ON CONFLICT (
            company_id,
            stock_location_id,
            variant_id
          )
          DO NOTHING;
          `,
          [
            companyId.trim(),
            transfer.to_branch_id,
            transfer.to_location_id,
            item.variant_id,
          ],
        )

        const balanceResult = await client.query(
          `
            SELECT quantity
            FROM stock_balances
            WHERE company_id = $1
              AND stock_location_id = $2
              AND variant_id = $3
            FOR UPDATE;
            `,
          [companyId.trim(), transfer.to_location_id, item.variant_id],
        )

        const quantityBefore = Number(balanceResult.rows[0].quantity)

        const quantityAfter = quantityBefore + receivedQuantity

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
            companyId.trim(),
            transfer.to_location_id,
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
            'transfer_in',
            $5, $6, $7,
            'transfer',
            $8,
            $9,
            $10
          );
          `,
          [
            companyId.trim(),
            transfer.to_branch_id,
            transfer.to_location_id,
            item.variant_id,
            receivedQuantity,
            quantityBefore,
            quantityAfter,
            transfer.id,
            `Transfer ${transfer.transfer_number} received`,
            createdBy || null,
          ],
        )

        await client.query(
          `
          UPDATE transfer_items
          SET received_quantity = $1
          WHERE company_id = $2
            AND transfer_id = $3
            AND id = $4;
          `,
          [receivedQuantity, companyId.trim(), transferId, item.id],
        )
      }

      const updatedTransferResult = await client.query(
        `
          UPDATE transfers
          SET
            status = 'received',
            received_by = $1,
            received_at = NOW(),
            updated_at = NOW()
          WHERE company_id = $2
            AND id = $3
          RETURNING *;
          `,
        [createdBy || null, companyId.trim(), transferId],
      )

      await client.query('COMMIT')

      const details = await loadTransferDetails(
        companyId.trim(),
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
