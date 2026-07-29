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

// يحول الكمية إلى رقم صالح لقاعدة البيانات.
// المخزون يسمح بثلاث خانات عشرية فقط.
function parseStockCountQuantity(value: unknown) {
  const normalizedInput = typeof value === 'string' ? value.trim() : value

  if (
    normalizedInput === '' ||
    (typeof normalizedInput !== 'string' && typeof normalizedInput !== 'number')
  ) {
    return null
  }

  const numericValue = Number(normalizedInput)

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null
  }

  const normalizedValue = Number(numericValue.toFixed(3))

  if (Math.abs(numericValue - normalizedValue) > 0.0000001) {
    return null
  }

  if (normalizedValue > 99_999_999_999.999) {
    return null
  }

  return normalizedValue
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

      // لو الواجهة أعادت نفس الطلب نرجع نفس شكل
      // استجابة الإنشاء، بدون إنشاء Snapshot جديد.
      const existingResult = await client.query(
        `
          SELECT
            ROW_TO_JSON(stock_count)
              AS stock_count,

            JSON_BUILD_OBJECT(
              'id', location.id,
              'branch_id', location.branch_id,
              'code', location.code,
              'name', location.name,
              'location_type', location.location_type
            ) AS location,

            (
              SELECT COUNT(*)::integer

              FROM inventory_stock_count_items item

              WHERE item.company_id =
                    stock_count.company_id

                AND item.stock_count_id =
                    stock_count.id
            ) AS item_count

          FROM inventory_stock_counts stock_count

          JOIN stock_locations location
            ON location.company_id =
               stock_count.company_id

            AND location.id =
                stock_count.stock_location_id

          WHERE stock_count.company_id = $1
            AND stock_count.idempotency_key = $2

          LIMIT 1;
        `,
        [auth.companyId, normalizedIdempotencyKey],
      )

      if ((existingResult.rowCount ?? 0) > 0) {
        const existing = existingResult.rows[0]

        await client.query('COMMIT')

        return res.status(200).json({
          data: {
            stockCount: existing.stock_count,
            location: existing.location,
            itemCount: existing.item_count,
          },
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

// ======================================================
// GET /api/inventory/stock-counts
//
// يعرض جلسات الجرد الخاصة بالشركة.
// مستخدم الفرع يرى جلسات فرعه فقط.
//
// Query:
// - status?
// - stockLocationId?
// - limit?
// ======================================================
inventoryStockCountsRouter.get(
  '/api/inventory/stock-counts',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const requestedStatus =
        typeof req.query.status === 'string'
          ? req.query.status.trim().toLowerCase()
          : ''

      const allowedStatuses = ['draft', 'completed', 'cancelled']

      if (requestedStatus && !allowedStatuses.includes(requestedStatus)) {
        return res.status(400).json({
          error: 'status is invalid',
        })
      }

      const stockLocationId =
        typeof req.query.stockLocationId === 'string'
          ? req.query.stockLocationId.trim().toLowerCase()
          : ''

      if (stockLocationId && !isUuid(stockLocationId)) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      const requestedLimit = Number(req.query.limit ?? 100)

      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
        : 100

      const result = await db.query(
        `
          SELECT
            stock_count.id,
            stock_count.company_id,
            stock_count.branch_id,
            stock_count.stock_location_id,

            stock_count.count_number,
            stock_count.status,
            stock_count.notes,

            stock_count.created_by,
            stock_count.completed_by,
            stock_count.cancelled_by,

            stock_count.created_at,
            stock_count.completed_at,
            stock_count.cancelled_at,
            stock_count.updated_at,

            location.code AS stock_location_code,
            location.name AS stock_location_name,
            location.location_type,

            creator.full_name AS created_by_name,

            COUNT(item.id)::integer
              AS item_count,

            (
              COUNT(item.id)
              FILTER (
                WHERE item.counted_quantity IS NOT NULL
              )
            )::integer AS counted_item_count,

            (
              COUNT(item.id)
              FILTER (
                WHERE item.difference_quantity <> 0
              )
            )::integer AS difference_item_count

          FROM inventory_stock_counts stock_count

          JOIN stock_locations location
            ON location.company_id =
               stock_count.company_id

            AND location.id =
                stock_count.stock_location_id

          LEFT JOIN users creator
            ON creator.company_id =
               stock_count.company_id

            AND creator.id =
                stock_count.created_by

          LEFT JOIN inventory_stock_count_items item
            ON item.company_id =
               stock_count.company_id

            AND item.stock_count_id =
                stock_count.id

          WHERE stock_count.company_id = $1

            AND (
              $2::uuid IS NULL
              OR location.branch_id = $2
            )

            AND (
              $3::text IS NULL
              OR stock_count.status = $3
            )

            AND (
              $4::uuid IS NULL
              OR stock_count.stock_location_id = $4
            )

          GROUP BY
            stock_count.id,
            location.id,
            creator.id

          ORDER BY stock_count.created_at DESC

          LIMIT $5;
        `,
        [
          auth.companyId,
          auth.branchId,
          requestedStatus || null,
          stockLocationId || null,
          limit,
        ],
      )

      return res.json({
        data: result.rows,
        meta: {
          limit,
          branchSelectionLocked: Boolean(auth.branchId),
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/inventory/stock-counts/:stockCountId
//
// يعرض رأس جلسة الجرد وكل أصنافها.
// ======================================================
inventoryStockCountsRouter.get(
  '/api/inventory/stock-counts/:stockCountId',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const stockCountId =
        typeof req.params.stockCountId === 'string'
          ? req.params.stockCountId.trim().toLowerCase()
          : ''

      if (!isUuid(stockCountId)) {
        return res.status(400).json({
          error: 'stockCountId is invalid',
        })
      }

      const stockCountResult = await db.query(
        `
          SELECT
            stock_count.*,

            location.code AS stock_location_code,
            location.name AS stock_location_name,
            location.location_type,

            creator.full_name AS created_by_name,
            completer.full_name AS completed_by_name,
            canceller.full_name AS cancelled_by_name

          FROM inventory_stock_counts stock_count

          JOIN stock_locations location
            ON location.company_id =
               stock_count.company_id

            AND location.id =
                stock_count.stock_location_id

          LEFT JOIN users creator
            ON creator.company_id =
               stock_count.company_id

            AND creator.id =
                stock_count.created_by

          LEFT JOIN users completer
            ON completer.company_id =
               stock_count.company_id

            AND completer.id =
                stock_count.completed_by

          LEFT JOIN users canceller
            ON canceller.company_id =
               stock_count.company_id

            AND canceller.id =
                stock_count.cancelled_by

          WHERE stock_count.company_id = $1
            AND stock_count.id = $2

            AND (
              $3::uuid IS NULL
              OR location.branch_id = $3
            )

          LIMIT 1;
        `,
        [auth.companyId, stockCountId, auth.branchId],
      )

      if ((stockCountResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'جلسة الجرد غير موجودة أو غير مسموح بها.',
        })
      }

      const itemsResult = await db.query(
        `
          SELECT
            item.id,
            item.company_id,
            item.stock_count_id,
            item.variant_id,

            item.expected_quantity,
            item.counted_quantity,
            item.difference_quantity,

            item.updated_by,
            item.updated_at,

            variant.product_id,
            variant.sku,
            variant.primary_barcode,

            product.name AS product_name,

            size.name AS size_name,
            color.name AS color_name,

            updater.full_name AS updated_by_name

          FROM inventory_stock_count_items item

          JOIN product_variants variant
            ON variant.company_id =
               item.company_id

            AND variant.id =
                item.variant_id

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

          LEFT JOIN fashion_sizes size
            ON size.company_id =
               variant.company_id

            AND size.id =
                variant.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id =
               variant.company_id

            AND color.id =
                variant.color_id

          LEFT JOIN users updater
            ON updater.company_id =
               item.company_id

            AND updater.id =
                item.updated_by

          WHERE item.company_id = $1
            AND item.stock_count_id = $2

          ORDER BY
            product.name ASC,
            variant.sku ASC;
        `,
        [auth.companyId, stockCountId],
      )

      const countedItemCount = itemsResult.rows.filter(
        (item) => item.counted_quantity !== null,
      ).length

      const differenceItemCount = itemsResult.rows.filter(
        (item) =>
          item.difference_quantity !== null &&
          Number(item.difference_quantity) !== 0,
      ).length

      return res.json({
        data: {
          stockCount: stockCountResult.rows[0],
          items: itemsResult.rows,
        },
        meta: {
          itemCount: itemsResult.rows.length,
          countedItemCount,
          differenceItemCount,
          remainingItemCount: itemsResult.rows.length - countedItemCount,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// PUT /api/inventory/stock-counts/:stockCountId/items/:itemId
//
// يسجل الكمية الفعلية لصنف داخل جلسة Draft.
// يمكن تعديل الكمية مرة أخرى قبل اعتماد الجرد.
//
// Body:
// {
//   countedQuantity
// }
// ======================================================
inventoryStockCountsRouter.put(
  '/api/inventory/stock-counts/:stockCountId/items/:itemId',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const stockCountId =
        typeof req.params.stockCountId === 'string'
          ? req.params.stockCountId.trim().toLowerCase()
          : ''

      const itemId =
        typeof req.params.itemId === 'string'
          ? req.params.itemId.trim().toLowerCase()
          : ''

      if (!isUuid(stockCountId)) {
        return res.status(400).json({
          error: 'stockCountId is invalid',
        })
      }

      if (!isUuid(itemId)) {
        return res.status(400).json({
          error: 'itemId is invalid',
        })
      }

      const normalizedQuantity = parseStockCountQuantity(
        req.body.countedQuantity,
      )

      if (normalizedQuantity === null) {
        return res.status(400).json({
          error:
            'countedQuantity must be a non-negative number with at most 3 decimal places',
        })
      }

      await client.query('BEGIN')

      // نقفل رأس المستند حتى لا يتم اعتماده
      // أثناء تعديل أحد أصناف الجرد.
      const stockCountResult = await client.query(
        `
          SELECT
            stock_count.id,
            stock_count.branch_id,
            stock_count.stock_location_id,
            stock_count.count_number,
            stock_count.status

          FROM inventory_stock_counts stock_count

          JOIN stock_locations location
            ON location.company_id =
               stock_count.company_id

            AND location.id =
                stock_count.stock_location_id

          WHERE stock_count.company_id = $1
            AND stock_count.id = $2

            AND (
              $3::uuid IS NULL
              OR location.branch_id = $3
            )

          FOR UPDATE OF stock_count;
        `,
        [auth.companyId, stockCountId, auth.branchId],
      )

      if ((stockCountResult.rowCount ?? 0) === 0) {
        throw new InventoryStockCountError(
          404,
          'جلسة الجرد غير موجودة أو غير مسموح بها.',
        )
      }

      const stockCount = stockCountResult.rows[0]

      if (stockCount.status !== 'draft') {
        throw new InventoryStockCountError(
          409,
          'لا يمكن تعديل جرد مكتمل أو ملغي.',
        )
      }

      // نقفل صنف الجرد نفسه حتى لا يتم حفظ قيمتين
      // متزامنتين لنفس الصنف.
      const itemResult = await client.query(
        `
          SELECT
            item.*,

            variant.product_id,
            variant.sku,
            variant.primary_barcode,

            product.name AS product_name,

            size.name AS size_name,
            color.name AS color_name

          FROM inventory_stock_count_items item

          JOIN product_variants variant
            ON variant.company_id =
               item.company_id

            AND variant.id =
                item.variant_id

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

          LEFT JOIN fashion_sizes size
            ON size.company_id =
               variant.company_id

            AND size.id =
                variant.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id =
               variant.company_id

            AND color.id =
                variant.color_id

          WHERE item.company_id = $1
            AND item.stock_count_id = $2
            AND item.id = $3

          FOR UPDATE OF item;
        `,
        [auth.companyId, stockCountId, itemId],
      )

      if ((itemResult.rowCount ?? 0) === 0) {
        throw new InventoryStockCountError(404, 'صنف الجرد غير موجود.')
      }

      const oldItem = itemResult.rows[0]

      const differenceQuantity = Number(
        (normalizedQuantity - Number(oldItem.expected_quantity)).toFixed(3),
      )

      const updatedItemResult = await client.query(
        `
          UPDATE inventory_stock_count_items

          SET
            counted_quantity = $1,
            difference_quantity = $2,
            updated_by = $3,
            updated_at = NOW()

          WHERE company_id = $4
            AND stock_count_id = $5
            AND id = $6

          RETURNING *;
        `,
        [
          normalizedQuantity,
          differenceQuantity,
          auth.userId,

          auth.companyId,
          stockCountId,
          itemId,
        ],
      )

      const updatedItem = updatedItemResult.rows[0]

      // كل تعديل في نتيجة العد يُحفظ في Audit Log.
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
            'inventory.stock_count.item_counted',
            'inventory_stock_count_item',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          stockCount.branch_id,
          auth.userId,

          updatedItem.id,

          JSON.stringify({
            countedQuantity: oldItem.counted_quantity,
            differenceQuantity: oldItem.difference_quantity,
          }),

          JSON.stringify({
            countedQuantity: updatedItem.counted_quantity,
            differenceQuantity: updatedItem.difference_quantity,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.json({
        data: {
          item: {
            ...updatedItem,

            product_id: oldItem.product_id,
            product_name: oldItem.product_name,

            sku: oldItem.sku,
            primary_barcode: oldItem.primary_barcode,

            size_name: oldItem.size_name,
            color_name: oldItem.color_name,
          },
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

// ======================================================
// POST /api/inventory/stock-counts/:stockCountId/complete
//
// يعتمد جلسة الجرد ويحوّل فروق العد إلى حركات مخزون.
//
// شروط الاعتماد:
// 1. المستند ما زال Draft.
// 2. كل الأصناف تم إدخال كمياتها الفعلية.
// 3. الرصيد لم يتغير منذ فتح جلسة الجرد.
//
// لو الرصيد تغير بسبب بيع أو تحويل، نرفض الاعتماد حتى
// لا يتم تطبيق نتيجة جرد قديمة فوق حركات أحدث.
// ======================================================
inventoryStockCountsRouter.post(
  '/api/inventory/stock-counts/:stockCountId/complete',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const stockCountId =
        typeof req.params.stockCountId === 'string'
          ? req.params.stockCountId.trim().toLowerCase()
          : ''

      if (!isUuid(stockCountId)) {
        return res.status(400).json({
          error: 'stockCountId is invalid',
        })
      }

      await client.query('BEGIN')

      // قفل رأس المستند يمنع الاعتماد والإلغاء
      // أو تعديل أحد الأصناف في نفس الوقت.
      const stockCountResult = await client.query(
        `
          SELECT
            stock_count.*,

            location.code AS stock_location_code,
            location.name AS stock_location_name,
            location.location_type

          FROM inventory_stock_counts stock_count

          JOIN stock_locations location
            ON location.company_id =
               stock_count.company_id

            AND location.id =
                stock_count.stock_location_id

          WHERE stock_count.company_id = $1
            AND stock_count.id = $2

            AND (
              $3::uuid IS NULL
              OR location.branch_id = $3
            )

          FOR UPDATE OF stock_count;
        `,
        [auth.companyId, stockCountId, auth.branchId],
      )

      if ((stockCountResult.rowCount ?? 0) === 0) {
        throw new InventoryStockCountError(
          404,
          'جلسة الجرد غير موجودة أو غير مسموح بها.',
        )
      }

      const stockCount = stockCountResult.rows[0]

      // إعادة محاولة اعتماد مستند مكتمل لا تنشئ
      // حركات مخزون جديدة.
      if (stockCount.status === 'completed') {
        const movementCountResult = await client.query(
          `
            SELECT COUNT(*)::integer AS movement_count

            FROM stock_movements

            WHERE company_id = $1
              AND reference_type =
                  'inventory_stock_count'

              AND reference_id = $2;
          `,
          [auth.companyId, stockCountId],
        )

        await client.query('COMMIT')

        return res.status(200).json({
          data: {
            stockCount,
            movementCount: movementCountResult.rows[0].movement_count,
          },
          meta: {
            duplicate: true,
          },
        })
      }

      if (stockCount.status === 'cancelled') {
        throw new InventoryStockCountError(
          409,
          'لا يمكن اعتماد جلسة جرد ملغية.',
        )
      }

      // نقفل كل أصناف الجرد بترتيب ثابت.
      // نفس الترتيب يقلل احتمالات Deadlock.
      const itemsResult = await client.query(
        `
          SELECT
            id,
            variant_id,
            expected_quantity,
            counted_quantity,
            difference_quantity

          FROM inventory_stock_count_items

          WHERE company_id = $1
            AND stock_count_id = $2

          ORDER BY variant_id

          FOR UPDATE;
        `,
        [auth.companyId, stockCountId],
      )

      if ((itemsResult.rowCount ?? 0) === 0) {
        throw new InventoryStockCountError(
          409,
          'جلسة الجرد لا تحتوي على أصناف.',
        )
      }

      const uncountedItems = itemsResult.rows.filter(
        (item) => item.counted_quantity === null,
      )

      if (uncountedItems.length > 0) {
        throw new InventoryStockCountError(
          409,
          `يوجد ${uncountedItems.length} صنف لم يتم إدخال كميته الفعلية.`,
        )
      }

      // نقفل الأرصدة الحالية قبل مقارنتها بالـSnapshot.
      const balancesResult = await client.query(
        `
          SELECT
            balance.id AS balance_id,
            balance.variant_id,
            balance.quantity AS current_quantity,

            item.expected_quantity,
            item.counted_quantity,
            item.difference_quantity,

            (
              balance.quantity <>
              item.expected_quantity
            ) AS changed_since_open

          FROM inventory_stock_count_items item

          JOIN stock_balances balance
            ON balance.company_id =
               item.company_id

            AND balance.stock_location_id = $3
            AND balance.variant_id =
                item.variant_id

          WHERE item.company_id = $1
            AND item.stock_count_id = $2

          ORDER BY item.variant_id

          FOR UPDATE OF balance;
        `,
        [auth.companyId, stockCountId, stockCount.stock_location_id],
      )

      // اختفاء أي صف رصيد بعد فتح الجرد يعتبر تعارضًا.
      if ((balancesResult.rowCount ?? 0) !== (itemsResult.rowCount ?? 0)) {
        throw new InventoryStockCountError(
          409,
          'بعض أرصدة الأصناف تغيرت أو لم تعد موجودة منذ فتح الجرد.',
        )
      }

      const changedBalances = balancesResult.rows.filter(
        (balance) => balance.changed_since_open,
      )

      if (changedBalances.length > 0) {
        throw new InventoryStockCountError(
          409,
          `تغير رصيد ${changedBalances.length} صنف منذ فتح الجرد. ألغِ الجلسة وافتح جردًا جديدًا.`,
        )
      }

      // نعدّل الأرصدة التي يوجد بها فرق فقط.
      // الأصناف المتطابقة لا تحتاج حركة مخزون.
      const updatedBalancesResult = await client.query(
        `
          UPDATE stock_balances balance

          SET
            quantity = item.counted_quantity,
            branch_id = $3,
            updated_at = NOW()

          FROM inventory_stock_count_items item

          WHERE item.company_id = $1
            AND item.stock_count_id = $2

            AND balance.company_id =
                item.company_id

            AND balance.stock_location_id = $4
            AND balance.variant_id =
                item.variant_id

            AND item.difference_quantity <> 0

          RETURNING
            balance.id,
            balance.variant_id,
            balance.quantity,
            balance.updated_at;
        `,
        [
          auth.companyId,
          stockCountId,
          stockCount.branch_id,
          stockCount.stock_location_id,
        ],
      )

      const movementNote = `Stock count ${stockCount.count_number}`

      // كل فرق موجب أو سالب ينتج عنه Stock Movement.
      // المستند نفسه هو المرجع الدائم لكل الحركات.
      const movementsResult = await client.query(
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

          SELECT
            item.company_id,
            $3,
            $4,
            item.variant_id,

            'stock_count',
            item.difference_quantity,
            item.expected_quantity,
            item.counted_quantity,

            'inventory_stock_count',
            $2,

            $5,
            $6

          FROM inventory_stock_count_items item

          WHERE item.company_id = $1
            AND item.stock_count_id = $2
            AND item.difference_quantity <> 0

          ORDER BY item.variant_id

          RETURNING *;
        `,
        [
          auth.companyId,
          stockCountId,
          stockCount.branch_id,
          stockCount.stock_location_id,
          movementNote,
          auth.userId,
        ],
      )

      // نغلق المستند بعد نجاح تحديث كل الأرصدة والحركات.
      const completedResult = await client.query(
        `
          UPDATE inventory_stock_counts

          SET
            status = 'completed',
            completed_by = $1,
            completed_at = NOW(),
            updated_at = NOW()

          WHERE company_id = $2
            AND id = $3

          RETURNING *;
        `,
        [auth.userId, auth.companyId, stockCountId],
      )

      const completedStockCount = completedResult.rows[0]

      const differenceItems = itemsResult.rows.filter(
        (item) => Number(item.difference_quantity) !== 0,
      )

      const totalAbsoluteDifference = differenceItems.reduce(
        (total, item) => total + Math.abs(Number(item.difference_quantity)),
        0,
      )

      // نسجل ملخص الاعتماد بدل إنشاء Audit إضافي
      // لكل حركة؛ تفاصيل الحركات موجودة في stock_movements.
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
            'inventory.stock_count.completed',
            'inventory_stock_count',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          stockCount.branch_id,
          auth.userId,

          stockCountId,

          JSON.stringify({
            status: 'draft',
          }),

          JSON.stringify({
            status: 'completed',
            itemCount: itemsResult.rows.length,
            differenceItemCount: differenceItems.length,
            movementCount: movementsResult.rowCount ?? 0,
            totalAbsoluteDifference,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.json({
        data: {
          stockCount: completedStockCount,

          summary: {
            itemCount: itemsResult.rows.length,
            differenceItemCount: differenceItems.length,
            movementCount: movementsResult.rowCount ?? 0,
            updatedBalanceCount: updatedBalancesResult.rowCount ?? 0,
            totalAbsoluteDifference,
          },

          movements: movementsResult.rows,
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

// ======================================================
// POST /api/inventory/stock-counts/:stockCountId/cancel
//
// يلغي جلسة Draft بدون تغيير الأرصدة أو إنشاء حركات.
// إعادة محاولة إلغاء نفس المستند آمنة.
// ======================================================
inventoryStockCountsRouter.post(
  '/api/inventory/stock-counts/:stockCountId/cancel',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const stockCountId =
        typeof req.params.stockCountId === 'string'
          ? req.params.stockCountId.trim().toLowerCase()
          : ''

      if (!isUuid(stockCountId)) {
        return res.status(400).json({
          error: 'stockCountId is invalid',
        })
      }

      await client.query('BEGIN')

      // قفل المستند يمنع الإلغاء أثناء الاعتماد
      // أو أثناء تعديل كمية أحد الأصناف.
      const stockCountResult = await client.query(
        `
          SELECT
            stock_count.*,

            location.code AS stock_location_code,
            location.name AS stock_location_name

          FROM inventory_stock_counts stock_count

          JOIN stock_locations location
            ON location.company_id =
               stock_count.company_id

            AND location.id =
                stock_count.stock_location_id

          WHERE stock_count.company_id = $1
            AND stock_count.id = $2

            AND (
              $3::uuid IS NULL
              OR location.branch_id = $3
            )

          FOR UPDATE OF stock_count;
        `,
        [auth.companyId, stockCountId, auth.branchId],
      )

      if ((stockCountResult.rowCount ?? 0) === 0) {
        throw new InventoryStockCountError(
          404,
          'جلسة الجرد غير موجودة أو غير مسموح بها.',
        )
      }

      const stockCount = stockCountResult.rows[0]

      if (stockCount.status === 'completed') {
        throw new InventoryStockCountError(
          409,
          'لا يمكن إلغاء جلسة جرد تم اعتمادها.',
        )
      }

      // إعادة محاولة الإلغاء لا تسجل Audit جديدًا.
      if (stockCount.status === 'cancelled') {
        await client.query('COMMIT')

        return res.status(200).json({
          data: {
            stockCount,
          },
          meta: {
            duplicate: true,
          },
        })
      }

      const cancelledResult = await client.query(
        `
          UPDATE inventory_stock_counts

          SET
            status = 'cancelled',
            cancelled_by = $1,
            cancelled_at = NOW(),
            updated_at = NOW()

          WHERE company_id = $2
            AND id = $3

          RETURNING *;
        `,
        [auth.userId, auth.companyId, stockCountId],
      )

      const cancelledStockCount = cancelledResult.rows[0]

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
            'inventory.stock_count.cancelled',
            'inventory_stock_count',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          stockCount.branch_id,
          auth.userId,

          stockCountId,

          JSON.stringify({
            status: 'draft',
          }),

          JSON.stringify({
            status: 'cancelled',
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.json({
        data: {
          stockCount: cancelledStockCount,
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
