import type { PoolClient } from 'pg'
import { db } from '../../db/pool'
import { hashSessionToken } from '../auth/auth.middleware'
import type { PosDeviceContext } from './pos-device-auth.middleware'

type SyncItemStatus = 'processed' | 'needs_review' | 'failed' | 'duplicate'

type ConflictSeverity = 'info' | 'warning' | 'critical'

type OfflineConflict = {
  type: string
  severity: ConflictSeverity
  details: Record<string, unknown>
}

type NormalizedItem = {
  variantId: string
  quantity: number
  submittedUnitPrice: number
}

type NormalizedPayment = {
  method: string
  amount: number
  reference: string | null
}

type NormalizedOfflineSale = {
  localSaleId: string
  idempotencyKey: string
  saleNumber: string
  stockLocationId: string
  cashierId: string

  cashierGrantId: string
  cashierGrantToken: string

  shiftId: string | null
  customerId: string | null
  occurredAt: string
  items: NormalizedItem[]
  payments: NormalizedPayment[]
}

export type OfflineSaleProcessResult = {
  syncStatus: SyncItemStatus
  duplicate: boolean
  sale: Record<string, unknown>
  items: Array<Record<string, unknown>>
  payments: Array<Record<string, unknown>>
  conflicts: OfflineConflict[]
}

export class OfflineSaleProcessingError extends Error {
  statusCode: number
  code: string
  syncStatus: 'failed' | 'needs_review'
  conflictType: string
  severity: ConflictSeverity
  details: Record<string, unknown>

  constructor(options: {
    statusCode: number
    code: string
    message: string
    syncStatus?: 'failed' | 'needs_review'
    conflictType?: string
    severity?: ConflictSeverity
    details?: Record<string, unknown>
  }) {
    super(options.message)

    this.statusCode = options.statusCode
    this.code = options.code
    this.syncStatus = options.syncStatus || 'failed'
    this.conflictType = options.conflictType || 'unknown'
    this.severity = options.severity || 'warning'
    this.details = options.details || {}
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const allowedPaymentMethods = new Set([
  'cash',
  'card',
  'wallet',
  'bank_transfer',
  'mixed',
  'other',
])

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function requiredString(value: unknown, fieldName: string, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OfflineSaleProcessingError({
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      message: `${fieldName} is required`,
      conflictType: 'invalid_payload',
      severity: 'warning',
    })
  }

  const result = value.trim()

  if (result.length > maxLength) {
    throw new OfflineSaleProcessingError({
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      message: `${fieldName} is too long`,
      conflictType: 'invalid_payload',
    })
  }

  return result
}

function optionalUuid(value: unknown, fieldName: string) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value !== 'string' || !uuidPattern.test(value.trim())) {
    throw new OfflineSaleProcessingError({
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      message: `${fieldName} is invalid`,
      conflictType: 'invalid_payload',
    })
  }

  return value.trim()
}

function normalizeOfflineSale(payload: unknown): NormalizedOfflineSale {
  const input = asRecord(payload)

  const localSaleId = requiredString(input.localSaleId, 'localSaleId')

  const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey')

  const saleNumber = requiredString(input.saleNumber, 'saleNumber')

  const stockLocationId = requiredString(
    input.stockLocationId,
    'stockLocationId',
  )

  const cashierId = requiredString(input.cashierId, 'cashierId')

  const cashierGrantId = requiredString(input.cashierGrantId, 'cashierGrantId')

  const cashierGrantToken = requiredString(
    input.cashierGrantToken,
    'cashierGrantToken',
    64,
  )

  if (
    !uuidPattern.test(stockLocationId) ||
    !uuidPattern.test(cashierId) ||
    !uuidPattern.test(cashierGrantId)
  ) {
    throw new OfflineSaleProcessingError({
      statusCode: 400,
      code: 'INVALID_PAYLOAD',
      message: 'stockLocationId or cashierId is invalid',
      conflictType: 'invalid_payload',
    })

    if (!/^[0-9a-f]{64}$/i.test(cashierGrantToken)) {
      throw new OfflineSaleProcessingError({
        statusCode: 400,
        code: 'INVALID_CASHIER_GRANT',
        message: 'cashierGrantToken is invalid',
        conflictType: 'cashier_grant_invalid',
        severity: 'critical',
      })
    }
  }

  const shiftId = optionalUuid(input.shiftId, 'shiftId')

  const customerId = optionalUuid(input.customerId, 'customerId')

  const occurredAtText = requiredString(input.occurredAt, 'occurredAt')

  const occurredAtDate = new Date(occurredAtText)

  if (
    Number.isNaN(occurredAtDate.getTime()) ||
    occurredAtDate.getTime() > Date.now() + 10 * 60 * 1000
  ) {
    throw new OfflineSaleProcessingError({
      statusCode: 400,
      code: 'INVALID_OCCURRED_AT',
      message: 'occurredAt is invalid',
      conflictType: 'invalid_payload',
    })
  }

  if (
    !Array.isArray(input.items) ||
    input.items.length === 0 ||
    input.items.length > 200
  ) {
    throw new OfflineSaleProcessingError({
      statusCode: 400,
      code: 'INVALID_ITEMS',
      message: 'items must contain between 1 and 200 items',
      conflictType: 'invalid_payload',
    })
  }

  const variantIds = new Set<string>()
  const items: NormalizedItem[] = []

  for (const rawItem of input.items) {
    const item = asRecord(rawItem)

    const variantId = requiredString(item.variantId, 'variantId')

    const quantity = roundQuantity(Number(item.quantity))

    const submittedUnitPrice = roundMoney(Number(item.unitPrice))

    if (!uuidPattern.test(variantId)) {
      throw new OfflineSaleProcessingError({
        statusCode: 400,
        code: 'INVALID_VARIANT_ID',
        message: 'variantId is invalid',
        conflictType: 'invalid_payload',
      })
    }

    if (variantIds.has(variantId)) {
      throw new OfflineSaleProcessingError({
        statusCode: 400,
        code: 'DUPLICATE_VARIANT',
        message: 'Duplicate variant inside offline sale',
        conflictType: 'invalid_payload',
      })
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new OfflineSaleProcessingError({
        statusCode: 400,
        code: 'INVALID_QUANTITY',
        message: 'Item quantity must be greater than zero',
        conflictType: 'invalid_payload',
      })
    }

    if (!Number.isFinite(submittedUnitPrice) || submittedUnitPrice < 0) {
      throw new OfflineSaleProcessingError({
        statusCode: 400,
        code: 'INVALID_PRICE',
        message: 'Item unit price is invalid',
        conflictType: 'invalid_payload',
      })
    }

    variantIds.add(variantId)

    items.push({
      variantId,
      quantity,
      submittedUnitPrice,
    })
  }

  if (
    !Array.isArray(input.payments) ||
    input.payments.length === 0 ||
    input.payments.length > 10
  ) {
    throw new OfflineSaleProcessingError({
      statusCode: 400,
      code: 'INVALID_PAYMENTS',
      message: 'payments must contain between 1 and 10 entries',
      conflictType: 'payment_mismatch',
    })
  }

  const payments: NormalizedPayment[] = []

  for (const rawPayment of input.payments) {
    const payment = asRecord(rawPayment)

    const method = requiredString(payment.method, 'payment.method')

    const amount = roundMoney(Number(payment.amount))

    if (!allowedPaymentMethods.has(method)) {
      throw new OfflineSaleProcessingError({
        statusCode: 400,
        code: 'INVALID_PAYMENT_METHOD',
        message: `Unsupported payment method: ${method}`,
        conflictType: 'payment_mismatch',
      })
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new OfflineSaleProcessingError({
        statusCode: 400,
        code: 'INVALID_PAYMENT_AMOUNT',
        message: 'Payment amount must be greater than zero',
        conflictType: 'payment_mismatch',
      })
    }

    payments.push({
      method,
      amount,
      reference:
        typeof payment.reference === 'string' && payment.reference.trim()
          ? payment.reference.trim()
          : null,
    })
  }

  return {
    localSaleId,
    idempotencyKey,
    saleNumber,
    stockLocationId,
    cashierId,

    cashierGrantId,
    cashierGrantToken,

    shiftId,
    customerId,
    occurredAt: occurredAtDate.toISOString(),
    items,
    payments,
  }
}

async function loadSaleDetails(companyId: string, saleId: string) {
  const [saleResult, itemsResult, paymentsResult] = await Promise.all([
    db.query(
      `
      SELECT *
      FROM sales
      WHERE company_id = $1
        AND id = $2
      LIMIT 1;
      `,
      [companyId, saleId],
    ),

    db.query(
      `
      SELECT *
      FROM sale_items
      WHERE company_id = $1
        AND sale_id = $2
      ORDER BY created_at ASC;
      `,
      [companyId, saleId],
    ),

    db.query(
      `
      SELECT *
      FROM payments
      WHERE company_id = $1
        AND sale_id = $2
      ORDER BY created_at ASC;
      `,
      [companyId, saleId],
    ),
  ])

  if ((saleResult.rowCount ?? 0) === 0) {
    return null
  }

  return {
    sale: saleResult.rows[0],
    items: itemsResult.rows,
    payments: paymentsResult.rows,
  }
}

async function findExistingOfflineSale(
  client: PoolClient,
  companyId: string,
  deviceId: string,
  sale: NormalizedOfflineSale,
) {
  const result = await client.query(
    `
    SELECT *
    FROM sales
    WHERE company_id = $1
      AND (
        idempotency_key = $2
        OR (
          pos_device_id = $3
          AND local_sale_id = $4
        )
      )
    ORDER BY
      CASE
        WHEN idempotency_key = $2
        THEN 1
        ELSE 2
      END
    LIMIT 1;
    `,
    [companyId, sale.idempotencyKey, deviceId, sale.localSaleId],
  )

  return result.rows[0] || null
}

export async function processOfflineSale(
  device: PosDeviceContext,
  rawPayload: unknown,
): Promise<OfflineSaleProcessResult> {
  const input = normalizeOfflineSale(rawPayload)

  const client = await db.connect()

  try {
    await client.query('BEGIN')

    const existingSale = await findExistingOfflineSale(
      client,
      device.companyId,
      device.deviceId,
      input,
    )

    if (existingSale) {
      if (
        existingSale.source !== 'offline_pos' ||
        existingSale.pos_device_id !== device.deviceId ||
        existingSale.local_sale_id !== input.localSaleId
      ) {
        throw new OfflineSaleProcessingError({
          statusCode: 409,
          code: 'DUPLICATE_SUSPECTED',
          message: 'Idempotency key or local sale ID belongs to another sale',
          syncStatus: 'needs_review',
          conflictType: 'duplicate_suspected',
          severity: 'critical',
          details: {
            existingSaleId: existingSale.id,
            localSaleId: input.localSaleId,
          },
        })
      }

      await client.query('COMMIT')

      const details = await loadSaleDetails(device.companyId, existingSale.id)

      if (!details) {
        throw new Error('Existing sale could not be loaded')
      }

      return {
        syncStatus: 'duplicate',
        duplicate: true,
        sale: details.sale,
        items: details.items,
        payments: details.payments,
        conflicts: [],
      }
    }

    const locationResult = await client.query(
      `
        SELECT
          id,
          branch_id,
          name,
          code,
          location_type
        FROM stock_locations
        WHERE company_id = $1
          AND id = $2
          AND branch_id = $3
          AND is_active = TRUE
          AND location_type IN (
            'sales_floor',
            'branch_warehouse'
          )
        FOR SHARE;
        `,
      [device.companyId, input.stockLocationId, device.branchId],
    )

    if ((locationResult.rowCount ?? 0) === 0) {
      throw new OfflineSaleProcessingError({
        statusCode: 404,
        code: 'STOCK_LOCATION_NOT_FOUND',
        message: 'Stock location is not allowed for this POS device',
        syncStatus: 'needs_review',
        conflictType: 'stock_location_not_found',
        severity: 'critical',
        details: {
          stockLocationId: input.stockLocationId,
        },
      })
    }

    const cashierResult = await client.query(
      `
        SELECT id
        FROM users
        WHERE company_id = $1
          AND id = $2
          AND branch_id = $3
          AND is_active = TRUE
        FOR SHARE;
        `,
      [device.companyId, input.cashierId, device.branchId],
    )

    if ((cashierResult.rowCount ?? 0) === 0) {
      throw new OfflineSaleProcessingError({
        statusCode: 404,
        code: 'CASHIER_NOT_FOUND',
        message: 'Cashier was not found or does not belong to device branch',
        syncStatus: 'needs_review',
        conflictType: 'cashier_not_found',
        severity: 'critical',
        details: {
          cashierId: input.cashierId,
        },
      })
    }

    const cashierGrantResult = await client.query(
      `
    SELECT id
    FROM pos_cashier_grants

    WHERE company_id = $1
      AND id = $2
      AND branch_id = $3
      AND device_id = $4
      AND cashier_id = $5
      AND token_hash = $6

      AND revoked_at IS NULL

      -- قد تتم المزامنة بعد انتهاء المنحة.
      -- المهم أن البيع حدث أثناء صلاحيتها.
      AND issued_at <=
          $7::timestamptz

      AND expires_at >=
          $7::timestamptz

    FOR SHARE;
    `,
      [
        device.companyId,
        input.cashierGrantId,
        device.branchId,
        device.deviceId,
        input.cashierId,

        hashSessionToken(input.cashierGrantToken),

        input.occurredAt,
      ],
    )

    if ((cashierGrantResult.rowCount ?? 0) === 0) {
      throw new OfflineSaleProcessingError({
        statusCode: 409,
        code: 'CASHIER_GRANT_INVALID',

        message: 'Cashier offline grant is invalid for this sale',

        syncStatus: 'needs_review',

        conflictType: 'cashier_grant_invalid',

        severity: 'critical',

        details: {
          cashierId: input.cashierId,

          cashierGrantId: input.cashierGrantId,

          deviceId: device.deviceId,
        },
      })
    }

    await client.query(
      `
  UPDATE pos_cashier_grants
  SET last_used_at = NOW()

  WHERE company_id = $1
    AND id = $2;
  `,
      [device.companyId, input.cashierGrantId],
    )

    if (input.customerId) {
      const customerResult = await client.query(
        `
          SELECT id
          FROM customers
          WHERE company_id = $1
            AND id = $2
            AND is_active = TRUE
          FOR SHARE;
          `,
        [device.companyId, input.customerId],
      )

      if ((customerResult.rowCount ?? 0) === 0) {
        throw new OfflineSaleProcessingError({
          statusCode: 404,
          code: 'CUSTOMER_NOT_FOUND',
          message: 'Customer was not found or inactive',
          syncStatus: 'needs_review',
          conflictType: 'customer_not_found',
          details: {
            customerId: input.customerId,
          },
        })
      }
    }

    if (input.shiftId) {
      const shiftResult = await client.query(
        `
          SELECT id
          FROM cashier_shifts
          WHERE company_id = $1
            AND id = $2
            AND branch_id = $3
            AND cashier_id = $4

            -- قد تتم المزامنة بعد إغلاق الوردية.
            -- المهم أن البيع حدث أثناء وقت الوردية.
            AND opened_at <= $5::timestamptz
            AND (
              closed_at IS NULL
              OR closed_at >= $5::timestamptz
            )

          FOR SHARE;
          `,
        [
          device.companyId,
          input.shiftId,
          device.branchId,
          input.cashierId,
          input.occurredAt,
        ],
      )

      if ((shiftResult.rowCount ?? 0) === 0) {
        throw new OfflineSaleProcessingError({
          statusCode: 409,
          code: 'SHIFT_NOT_FOUND',
          message: 'Cashier shift was not valid at the offline sale time',
          syncStatus: 'needs_review',
          conflictType: 'shift_not_found',
          details: {
            shiftId: input.shiftId,
          },
        })
      }
    }

    const sortedItems = [...input.items].sort((first, second) =>
      first.variantId.localeCompare(second.variantId),
    )

    const variantsResult = await client.query(
      `
        SELECT
          pv.id,
          pv.sku,
          pv.primary_barcode,
          pv.selling_price,

          p.name AS product_name,

          fs.name AS size_name,
          fc.name AS color_name

        FROM product_variants pv

        JOIN products p
          ON p.id = pv.product_id
          AND p.company_id = pv.company_id

        LEFT JOIN fashion_sizes fs
          ON fs.id = pv.size_id

        LEFT JOIN fashion_colors fc
          ON fc.id = pv.color_id

        WHERE pv.company_id = $1
          AND pv.id = ANY($2::uuid[])
          AND pv.status = 'active';
        `,
      [device.companyId, sortedItems.map((item) => item.variantId)],
    )

    if ((variantsResult.rowCount ?? 0) !== sortedItems.length) {
      const foundIds = new Set(variantsResult.rows.map((row) => row.id))

      const missingIds = sortedItems
        .filter((item) => !foundIds.has(item.variantId))
        .map((item) => item.variantId)

      throw new OfflineSaleProcessingError({
        statusCode: 404,
        code: 'VARIANT_NOT_FOUND',
        message: 'One or more offline sale variants were not found',
        syncStatus: 'needs_review',
        conflictType: 'variant_not_found',
        severity: 'critical',
        details: {
          variantIds: missingIds,
        },
      })
    }

    const variantsById = new Map(
      variantsResult.rows.map((row) => [row.id, row]),
    )

    const conflicts: OfflineConflict[] = []

    let subtotal = 0

    const preparedItems = sortedItems.map((item) => {
      const variant = variantsById.get(item.variantId)

      if (!variant) {
        throw new Error('Validated variant is missing')
      }

      const currentPrice = roundMoney(Number(variant.selling_price))

      if (!Number.isFinite(currentPrice) || currentPrice < 0) {
        throw new OfflineSaleProcessingError({
          statusCode: 409,
          code: 'INVALID_SERVER_PRICE',
          message: 'Current selling price is invalid',
          syncStatus: 'needs_review',
          conflictType: 'price_changed',
          severity: 'critical',
          details: {
            variantId: item.variantId,
          },
        })
      }

      if (Math.abs(currentPrice - item.submittedUnitPrice) > 0.009) {
        conflicts.push({
          type: 'price_changed',
          severity: 'warning',
          details: {
            variantId: item.variantId,
            sku: variant.sku,
            submittedUnitPrice: item.submittedUnitPrice,
            currentUnitPrice: currentPrice,
          },
        })
      }

      const lineTotal = roundMoney(item.quantity * item.submittedUnitPrice)

      subtotal = roundMoney(subtotal + lineTotal)

      return {
        ...item,
        lineTotal,
        skuSnapshot: variant.sku,
        barcodeSnapshot: variant.primary_barcode,
        productNameSnapshot: variant.product_name,
        sizeSnapshot: variant.size_name,
        colorSnapshot: variant.color_name,
      }
    })

    const paidTotal = roundMoney(
      input.payments.reduce((total, payment) => total + payment.amount, 0),
    )

    if (paidTotal < subtotal) {
      throw new OfflineSaleProcessingError({
        statusCode: 409,
        code: 'PAYMENT_MISMATCH',
        message: 'Offline payment total is less than sale total',
        syncStatus: 'needs_review',
        conflictType: 'payment_mismatch',
        severity: 'critical',
        details: {
          saleTotal: subtotal,
          paidTotal,
        },
      })
    }

    const stockRows = new Map<string, number>()

    let hasNegativeStockConflict = false

    for (const item of preparedItems) {
      const balanceResult = await client.query(
        `
          SELECT quantity
          FROM stock_balances
          WHERE company_id = $1
            AND stock_location_id = $2
            AND variant_id = $3
          FOR UPDATE;
          `,
        [device.companyId, input.stockLocationId, item.variantId],
      )

      const availableQuantity =
        (balanceResult.rowCount ?? 0) > 0
          ? Number(balanceResult.rows[0].quantity)
          : 0

      stockRows.set(item.variantId, availableQuantity)

      if (
        !Number.isFinite(availableQuantity) ||
        availableQuantity < item.quantity
      ) {
        hasNegativeStockConflict = true

        conflicts.push({
          type: 'negative_stock',
          severity: 'critical',
          details: {
            variantId: item.variantId,
            sku: item.skuSnapshot,
            availableQuantity,
            requestedQuantity: item.quantity,
          },
        })
      }
    }

    const saleStatus = conflicts.length > 0 ? 'pending_review' : 'completed'

    const changeTotal = roundMoney(Math.max(paidTotal - subtotal, 0))

    const saleResult = await client.query(
      `
        INSERT INTO sales (
          company_id,
          branch_id,
          stock_location_id,
          cashier_id,
          shift_id,
          customer_id,

          pos_device_id,
          pos_cashier_grant_id,

          sale_number,
          source,
          local_sale_id,
          idempotency_key,

          subtotal,
          discount_total,
          tax_total,
          total,
          paid_total,
          change_total,

          status,
          occurred_at,
          synced_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8,
          $9, 'offline_pos', $10, $11,
          $12, 0, 0, $12, $13, $14,
          $15,
          $16,
          NOW()
        )
        RETURNING *;
        `,
      [
        device.companyId,
        device.branchId,
        input.stockLocationId,
        input.cashierId,
        input.shiftId,
        input.customerId,

        device.deviceId,

        input.cashierGrantId,

        input.saleNumber,
        input.localSaleId,
        input.idempotencyKey,

        subtotal,
        paidTotal,
        changeTotal,

        saleStatus,
        input.occurredAt,
      ],
    )

    const sale = saleResult.rows[0]

    const createdItems: Array<Record<string, unknown>> = []

    for (const item of preparedItems) {
      const itemResult = await client.query(
        `
          INSERT INTO sale_items (
            company_id,
            sale_id,
            variant_id,

            sku_snapshot,
            barcode_snapshot,
            product_name_snapshot,
            size_snapshot,
            color_snapshot,

            quantity,
            unit_price,
            discount_amount,
            tax_amount,
            line_total
          )
          VALUES (
            $1, $2, $3,
            $4, $5, $6, $7, $8,
            $9, $10, 0, 0, $11
          )
          RETURNING *;
          `,
        [
          device.companyId,
          sale.id,
          item.variantId,
          item.skuSnapshot,
          item.barcodeSnapshot,
          item.productNameSnapshot,
          item.sizeSnapshot,
          item.colorSnapshot,
          item.quantity,
          item.submittedUnitPrice,
          item.lineTotal,
        ],
      )

      createdItems.push(itemResult.rows[0])
    }

    // عند تعارض المخزون لا نخصم بعض الأصناف دون الأخرى.
    // الفاتورة تحفظ pending_review كاملة.
    if (!hasNegativeStockConflict) {
      for (const item of preparedItems) {
        const quantityBefore = stockRows.get(item.variantId) ?? 0

        const quantityAfter = roundQuantity(quantityBefore - item.quantity)

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
            device.companyId,
            input.stockLocationId,
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
            'sale',
            $5, $6, $7,
            'sale',
            $8,
            $9,
            $10
          );
          `,
          [
            device.companyId,
            device.branchId,
            input.stockLocationId,
            item.variantId,
            -Math.abs(item.quantity),
            quantityBefore,
            quantityAfter,
            sale.id,
            `Offline POS sale ${sale.sale_number}`,
            input.cashierId,
          ],
        )
      }
    }

    const createdPayments: Array<Record<string, unknown>> = []

    for (const payment of input.payments) {
      const paymentResult = await client.query(
        `
          INSERT INTO payments (
            company_id,
            sale_id,
            method,
            amount,
            reference
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *;
          `,
        [
          device.companyId,
          sale.id,
          payment.method,
          payment.amount,
          payment.reference,
        ],
      )

      createdPayments.push(paymentResult.rows[0])
    }

    await client.query('COMMIT')

    return {
      syncStatus: conflicts.length > 0 ? 'needs_review' : 'processed',
      duplicate: false,
      sale,
      items: createdItems,
      payments: createdPayments,
      conflicts,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    if (isUniqueViolation(error)) {
      const existingResult = await db.query(
        `
          SELECT *
          FROM sales
          WHERE company_id = $1
            AND (
              idempotency_key = $2
              OR (
                pos_device_id = $3
                AND local_sale_id = $4
              )
            )
          LIMIT 1;
          `,
        [
          device.companyId,
          input.idempotencyKey,
          device.deviceId,
          input.localSaleId,
        ],
      )

      if ((existingResult.rowCount ?? 0) > 0) {
        const existing = existingResult.rows[0]

        if (
          existing.source === 'offline_pos' &&
          existing.pos_device_id === device.deviceId &&
          existing.local_sale_id === input.localSaleId
        ) {
          const details = await loadSaleDetails(device.companyId, existing.id)

          if (details) {
            return {
              syncStatus: 'duplicate',
              duplicate: true,
              sale: details.sale,
              items: details.items,
              payments: details.payments,
              conflicts: [],
            }
          }
        }
      }

      throw new OfflineSaleProcessingError({
        statusCode: 409,
        code: 'DUPLICATE_SUSPECTED',
        message: 'Sale number or idempotency key is already used',
        syncStatus: 'needs_review',
        conflictType: 'duplicate_suspected',
        severity: 'critical',
        details: {
          saleNumber: input.saleNumber,
          localSaleId: input.localSaleId,
        },
      })
    }

    throw error
  } finally {
    client.release()
  }
}
