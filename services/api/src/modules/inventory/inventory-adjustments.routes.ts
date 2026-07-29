import type { PoolClient } from 'pg'
import { Router } from 'express'

import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const inventoryAdjustmentsRouter = Router()

// خطأ متوقع نريد إرجاع status واضح بسببه.
class InventoryAdjustmentError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string) {
  return uuidPattern.test(value)
}

// يحول الكمية إلى ثلاث خانات عشرية.
// null تعني أن القيمة غير صالحة.
function parseCountedQuantity(value: unknown) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null
  }

  const normalizedValue = Number(numericValue.toFixed(3))

  // نرفض أكثر من 3 خانات عشرية بدل تقريبها بصمت.
  if (Math.abs(numericValue - normalizedValue) > 0.0000001) {
    return null
  }

  // يناسب NUMERIC(14,3).
  if (normalizedValue > 99_999_999_999.999) {
    return null
  }

  return normalizedValue
}

// يبحث عن طلب سابق بنفس Idempotency Key.
// استخدام نفس المفتاح يجب أن يعيد المستند القديم
// بدل إنشاء تسوية وحركة مخزون جديدتين.
async function loadExistingAdjustment(
  client: PoolClient,
  companyId: string,
  idempotencyKey: string,
) {
  const result = await client.query(
    `
      SELECT
        adjustment.*,
        movement.id AS movement_id

      FROM inventory_adjustments adjustment

      LEFT JOIN stock_movements movement
        ON movement.company_id =
           adjustment.company_id

        AND movement.reference_type =
            'inventory_adjustment'

        AND movement.reference_id =
            adjustment.id

      WHERE adjustment.company_id = $1
        AND adjustment.idempotency_key = $2

      LIMIT 1;
    `,
    [companyId, idempotencyKey],
  )

  return result.rows[0] ?? null
}

// ======================================================
// POST /api/inventory/adjustments
//
// Body:
// {
//   stockLocationId,
//   variantId,
//   countedQuantity,
//   reason,
//   idempotencyKey
// }
//
// companyId وbranchId وuserId يأتون من Session فقط.
// ======================================================
inventoryAdjustmentsRouter.post(
  '/api/inventory/adjustments',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const {
        stockLocationId,
        variantId,
        countedQuantity,
        reason,
        idempotencyKey,
      } = req.body

      if (
        typeof stockLocationId !== 'string' ||
        !isUuid(stockLocationId.trim())
      ) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      if (typeof variantId !== 'string' || !isUuid(variantId.trim())) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      if (
        typeof idempotencyKey !== 'string' ||
        !isUuid(idempotencyKey.trim())
      ) {
        return res.status(400).json({
          error: 'idempotencyKey is invalid',
        })
      }

      const normalizedQuantity = parseCountedQuantity(countedQuantity)

      if (normalizedQuantity === null) {
        return res.status(400).json({
          error:
            'countedQuantity must be a non-negative number with at most 3 decimal places',
        })
      }

      const normalizedReason = typeof reason === 'string' ? reason.trim() : ''

      if (normalizedReason.length < 3 || normalizedReason.length > 500) {
        return res.status(400).json({
          error: 'reason must contain between 3 and 500 characters',
        })
      }

      const normalizedLocationId = stockLocationId.trim().toLowerCase()

      const normalizedVariantId = variantId.trim().toLowerCase()

      const normalizedIdempotencyKey = idempotencyKey.trim().toLowerCase()

      await client.query('BEGIN')

      // يمنع تنفيذ طلبين متزامنين بنفس المفتاح.
      // القفل ينتهي تلقائيًا عند COMMIT أو ROLLBACK.
      await client.query(
        `
          SELECT pg_advisory_xact_lock(
            hashtextextended($1, 0)
          );
        `,
        [`${auth.companyId}:${normalizedIdempotencyKey}`],
      )

      const existingAdjustment = await loadExistingAdjustment(
        client,
        auth.companyId,
        normalizedIdempotencyKey,
      )

      if (existingAdjustment) {
        await client.query('COMMIT')

        return res.status(200).json({
          data: existingAdjustment,
          meta: {
            duplicate: true,
          },
        })
      }

      // نقرأ الصنف والمكان من الشركة الموثقة.
      // مستخدم الفرع لا يستطيع تعديل مخزن فرع آخر.
      const contextResult = await client.query(
        `
          SELECT
            location.id AS stock_location_id,
            location.branch_id AS trusted_branch_id,
            location.name AS stock_location_name,
            location.code AS stock_location_code,

            variant.id AS variant_id,
            variant.sku,
            variant.primary_barcode,

            product.name AS product_name

          FROM stock_locations location

          JOIN product_variants variant
            ON variant.company_id =
               location.company_id

            AND variant.id = $2
            AND variant.status = 'active'

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

            AND product.status = 'active'

          WHERE location.company_id = $1
            AND location.id = $3
            AND location.is_active = TRUE

            AND (
              $4::uuid IS NULL
              OR location.branch_id = $4
            )

          LIMIT 1;
        `,
        [
          auth.companyId,
          normalizedVariantId,
          normalizedLocationId,
          auth.branchId,
        ],
      )

      if ((contextResult.rowCount ?? 0) === 0) {
        throw new InventoryAdjustmentError(
          404,
          'الصنف أو مكان التخزين غير موجود أو غير مسموح.',
        )
      }

      const trustedContext = contextResult.rows[0]

      // ننشئ صف رصيد بصفر لو الصنف لم يكن له رصيد سابق.
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
          auth.companyId,
          trustedContext.trusted_branch_id,
          normalizedLocationId,
          normalizedVariantId,
        ],
      )

      // قفل الرصيد يمنع تسويتين أو عملية بيع
      // من تعديل الكمية نفسها في الوقت نفسه.
      const balanceResult = await client.query(
        `
          SELECT
            id,
            quantity

          FROM stock_balances

          WHERE company_id = $1
            AND stock_location_id = $2
            AND variant_id = $3

          FOR UPDATE;
        `,
        [auth.companyId, normalizedLocationId, normalizedVariantId],
      )

      if ((balanceResult.rowCount ?? 0) === 0) {
        throw new InventoryAdjustmentError(
          500,
          'Stock balance row could not be created',
        )
      }

      const balance = balanceResult.rows[0]
      const quantityBefore = Number(balance.quantity)

      // الفرق موجب في الزيادة وسالب في العجز.
      const adjustmentQuantity = Number(
        (normalizedQuantity - quantityBefore).toFixed(3),
      )

      if (adjustmentQuantity === 0) {
        throw new InventoryAdjustmentError(
          409,
          'الكمية الفعلية مساوية للرصيد الحالي ولا تحتاج إلى تسوية.',
        )
      }

      // إنشاء مستند التسوية أولًا ليصبح هو المرجع
      // الدائم لحركة المخزون.
      const adjustmentResult = await client.query(
        `
          INSERT INTO inventory_adjustments (
            company_id,
            branch_id,
            stock_location_id,
            variant_id,

            quantity_before,
            counted_quantity,
            adjustment_quantity,

            reason,
            idempotency_key,
            created_by
          )
          VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9, $10
          )
          RETURNING *;
        `,
        [
          auth.companyId,
          trustedContext.trusted_branch_id,
          normalizedLocationId,
          normalizedVariantId,

          quantityBefore,
          normalizedQuantity,
          adjustmentQuantity,

          normalizedReason,
          normalizedIdempotencyKey,
          auth.userId,
        ],
      )

      const adjustment = adjustmentResult.rows[0]

      // الرصيد الحالي يتغير داخل نفس Transaction.
      const updatedBalanceResult = await client.query(
        `
          UPDATE stock_balances

          SET
            quantity = $1,
            branch_id = $2,
            updated_at = NOW()

          WHERE id = $3
            AND company_id = $4

          RETURNING *;
        `,
        [
          normalizedQuantity,
          trustedContext.trusted_branch_id,
          balance.id,
          auth.companyId,
        ],
      )

      // كل تغيير في الرصيد يجب أن يملك حركة مخزون.
      const movementResult = await client.query(
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
            'adjustment', $5, $6, $7,
            'inventory_adjustment', $8,
            $9, $10
          )
          RETURNING *;
        `,
        [
          auth.companyId,
          trustedContext.trusted_branch_id,
          normalizedLocationId,
          normalizedVariantId,

          adjustmentQuantity,
          quantityBefore,
          normalizedQuantity,

          adjustment.id,
          normalizedReason,
          auth.userId,
        ],
      )

      const movement = movementResult.rows[0]

      // Audit Log يوضح من غيّر الرصيد ولماذا.
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
            $4, $5, $6,
            $7::jsonb, $8::jsonb,
            $9, $10
          );
        `,
        [
          auth.companyId,
          trustedContext.trusted_branch_id,
          auth.userId,

          'inventory.adjustment.created',
          'inventory_adjustment',
          adjustment.id,

          JSON.stringify({
            quantity: quantityBefore,
          }),

          JSON.stringify({
            quantity: normalizedQuantity,
            adjustmentQuantity,
            reason: normalizedReason,
            stockMovementId: movement.id,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        data: {
          adjustment,
          balance: updatedBalanceResult.rows[0],
          movement,
          item: trustedContext,
        },
        meta: {
          duplicate: false,
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof InventoryAdjustmentError) {
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
