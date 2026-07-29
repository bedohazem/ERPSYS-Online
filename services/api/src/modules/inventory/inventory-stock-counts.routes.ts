import { Router } from 'express'

import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const inventoryStockCountsRouter = Router()

// خطأ متوقع نرجعه للمستخدم بكود HTTP واضح.
class InventoryStockCountError extends Error {
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

// ======================================================
// POST /api/inventory/stock-counts
//
// يفتح جلسة جرد لمكان تخزين واحد، ويحفظ Snapshot
// من أرصدة الأصناف الموجودة وقت فتح الجرد.
//
// Body:
// {
//   stockLocationId,
//   idempotencyKey,
//   notes?
// }
//
// بيانات الشركة والفرع والمستخدم تأتي من Session فقط.
// ======================================================
inventoryStockCountsRouter.post(
  '/api/inventory/stock-counts',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const { stockLocationId, idempotencyKey, notes } = req.body

      if (
        typeof stockLocationId !== 'string' ||
        !isUuid(stockLocationId.trim())
      ) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
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

      if (notes !== undefined && notes !== null && typeof notes !== 'string') {
        return res.status(400).json({
          error: 'notes must be a string',
        })
      }

      // النص الفارغ يتحول إلى NULL حتى يطابق قاعدة البيانات.
      const normalizedNotes =
        typeof notes === 'string' && notes.trim() ? notes.trim() : null

      if (normalizedNotes && normalizedNotes.length > 500) {
        return res.status(400).json({
          error: 'notes cannot exceed 500 characters',
        })
      }

      const normalizedLocationId = stockLocationId.trim().toLowerCase()
      const normalizedIdempotencyKey = idempotencyKey.trim().toLowerCase()

      await client.query('BEGIN')

      // يمنع طلبين متزامنين بنفس Idempotency Key.
      await client.query(
        `
          SELECT pg_advisory_xact_lock(
            hashtextextended($1, 0)
          );
        `,
        [`${auth.companyId}:stock-count:${normalizedIdempotencyKey}`],
      )

      // لو الواجهة أعادت نفس الطلب، نرجع الجرد السابق
      // بدون إنشاء مستند أو Snapshot جديد.
      const existingResult = await client.query(
        `
          SELECT
            stock_count.*,

            (
              SELECT COUNT(*)::integer

              FROM inventory_stock_count_items item

              WHERE item.company_id =
                    stock_count.company_id

                AND item.stock_count_id =
                    stock_count.id
            ) AS item_count

          FROM inventory_stock_counts stock_count

          WHERE stock_count.company_id = $1
            AND stock_count.idempotency_key = $2

          LIMIT 1;
        `,
        [auth.companyId, normalizedIdempotencyKey],
      )

      if ((existingResult.rowCount ?? 0) > 0) {
        await client.query('COMMIT')

        return res.status(200).json({
          data: existingResult.rows[0],
          meta: {
            duplicate: true,
          },
        })
      }

      // يمنع فتح جلستين متزامنتين لنفس مكان التخزين.
      await client.query(
        `
          SELECT pg_advisory_xact_lock(
            hashtextextended($1, 1)
          );
        `,
        [`${auth.companyId}:stock-count-location:${normalizedLocationId}`],
      )

      // نأخذ الفرع الحقيقي من مكان التخزين.
      // مستخدم الفرع لا يستطيع جرد مخزن فرع آخر.
      const locationResult = await client.query(
        `
          SELECT
            location.id,
            location.branch_id,
            location.code,
            location.name,
            location.location_type

          FROM stock_locations location

          WHERE location.company_id = $1
            AND location.id = $2
            AND location.is_active = TRUE

            AND (
              $3::uuid IS NULL
              OR location.branch_id = $3
            )

          LIMIT 1;
        `,
        [auth.companyId, normalizedLocationId, auth.branchId],
      )

      if ((locationResult.rowCount ?? 0) === 0) {
        throw new InventoryStockCountError(
          404,
          'مكان التخزين غير موجود أو غير مسموح.',
        )
      }

      const location = locationResult.rows[0]

      // لا نسمح بأكثر من جلسة Draft لنفس المكان.
      const openCountResult = await client.query(
        `
          SELECT
            id,
            count_number

          FROM inventory_stock_counts

          WHERE company_id = $1
            AND stock_location_id = $2
            AND status = 'draft'

          LIMIT 1;
        `,
        [auth.companyId, normalizedLocationId],
      )

      if ((openCountResult.rowCount ?? 0) > 0) {
        throw new InventoryStockCountError(
          409,
          `يوجد جرد مفتوح بالفعل: ${openCountResult.rows[0].count_number}`,
        )
      }

      // نستخدم المفتاح كاملًا لضمان رقم مستند فريد
      // بدون الاعتماد على عدّ الصفوف أو ترتيب متزامن.
      const datePart = new Date().toISOString().slice(0, 10).replaceAll('-', '')

      const countNumber = `CNT-${datePart}-${normalizedIdempotencyKey.toUpperCase()}`

      const stockCountResult = await client.query(
        `
          INSERT INTO inventory_stock_counts (
            company_id,
            branch_id,
            stock_location_id,

            count_number,
            status,
            notes,

            idempotency_key,
            created_by
          )
          VALUES (
            $1, $2, $3,
            $4, 'draft', $5,
            $6, $7
          )
          RETURNING *;
        `,
        [
          auth.companyId,
          location.branch_id,
          normalizedLocationId,

          countNumber,
          normalizedNotes,

          normalizedIdempotencyKey,
          auth.userId,
        ],
      )

      const stockCount = stockCountResult.rows[0]

      // نحفظ الرصيد الحالي لكل صنف نشط كرصيد متوقع.
      // الكمية الفعلية تظل NULL حتى يبدأ الموظف العد.
      const itemsResult = await client.query(
        `
          INSERT INTO inventory_stock_count_items (
            company_id,
            stock_count_id,
            variant_id,

            expected_quantity,
            counted_quantity,
            difference_quantity
          )

          SELECT
            balance.company_id,
            $3,
            balance.variant_id,

            balance.quantity,
            NULL,
            NULL

          FROM stock_balances balance

          JOIN product_variants variant
            ON variant.company_id = balance.company_id
            AND variant.id = balance.variant_id
            AND variant.status = 'active'

          JOIN products product
            ON product.company_id = variant.company_id
            AND product.id = variant.product_id
            AND product.status = 'active'

          WHERE balance.company_id = $1
            AND balance.stock_location_id = $2

          ORDER BY balance.variant_id

          RETURNING id;
        `,
        [auth.companyId, normalizedLocationId, stockCount.id],
      )

      const itemCount = itemsResult.rowCount ?? 0

      if (itemCount === 0) {
        throw new InventoryStockCountError(
          409,
          'مكان التخزين لا يحتوي على أرصدة يمكن جردها.',
        )
      }

      // نسجل فتح الجرد في Audit Log.
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
            'inventory.stock_count.created',
            'inventory_stock_count',
            $4,
            NULL,
            $5::jsonb,
            $6,
            $7
          );
        `,
        [
          auth.companyId,
          location.branch_id,
          auth.userId,

          stockCount.id,

          JSON.stringify({
            countNumber: stockCount.count_number,
            stockLocationId: normalizedLocationId,
            status: stockCount.status,
            itemCount,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        data: {
          stockCount,
          location,
          itemCount,
        },
        meta: {
          duplicate: false,
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof InventoryStockCountError) {
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
