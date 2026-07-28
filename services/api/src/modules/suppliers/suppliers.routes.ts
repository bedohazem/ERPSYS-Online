import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'
export const suppliersRouter = Router()

function isPostgresUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

function parseSupplierLimit(value: unknown) {
  const numericValue = Number(value ?? 50)

  if (!Number.isFinite(numericValue)) {
    return 50
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

class SupplierSourceApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const supplierSourceUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isSupplierSourceUuid(value: string) {
  return supplierSourceUuidPattern.test(value)
}

function roundSupplierMoney(value: number) {
  return Number(value.toFixed(2))
}

function roundSupplierQuantity(value: number) {
  return Number(value.toFixed(3))
}

function serializeSupplierTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return typeof value === 'string' ? value : null
}

function mapSupplierVariantSource(row: Record<string, unknown>) {
  return {
    id: String(row.id),

    companyId: String(row.company_id),

    branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

    branchCode: typeof row.branch_code === 'string' ? row.branch_code : null,

    branchName: typeof row.branch_name === 'string' ? row.branch_name : null,

    supplierId: String(row.supplier_id),

    supplierName: String(row.supplier_name),

    supplierCode: String(row.supplier_code),

    supplierIsActive: Boolean(row.supplier_is_active),

    variantId: String(row.variant_id),

    productId: String(row.product_id),

    productName: String(row.product_name),

    sku: String(row.sku),

    primaryBarcode:
      typeof row.primary_barcode === 'string' ? row.primary_barcode : null,

    sizeName: typeof row.size_name === 'string' ? row.size_name : null,

    colorName: typeof row.color_name === 'string' ? row.color_name : null,

    productStatus: String(row.product_status),

    variantStatus: String(row.variant_status),

    supplierSku: typeof row.supplier_sku === 'string' ? row.supplier_sku : null,

    defaultUnitCost:
      row.default_unit_cost === null || row.default_unit_cost === undefined
        ? null
        : String(row.default_unit_cost),

    minimumOrderQuantity: String(row.minimum_order_quantity),

    orderMultiple: String(row.order_multiple),

    leadTimeDays: Number(row.lead_time_days),

    isPreferred: Boolean(row.is_preferred),

    isActive: Boolean(row.is_active),

    scope: row.branch_id ? 'branch' : 'company',

    createdBy: typeof row.created_by === 'string' ? row.created_by : null,

    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : null,

    createdAt: serializeSupplierTimestamp(row.created_at),

    updatedAt: serializeSupplierTimestamp(row.updated_at),
  }
}

// ======================================================
// GET /api/suppliers
//
// عرض الموردين النشطين والبحث بالاسم أو الكود أو الهاتف.
// companyId يتم فرضه من Session.
// ======================================================
suppliersRouter.get('/api/suppliers', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const query = req.query.q

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    const searchText =
      typeof query === 'string' && query.trim() ? `%${query.trim()}%` : null

    const result = await db.query(
      `
        SELECT
          id,
          company_id,
          name,
          code,
          phone,
          email,
          address,
          tax_number,
          is_active,
          created_at,
          updated_at
        FROM suppliers
        WHERE company_id = $1
          AND is_active = TRUE
          AND (
            $2::text IS NULL
            OR name ILIKE $2
            OR code ILIKE $2
            OR phone ILIKE $2
            OR email ILIKE $2
          )
        ORDER BY name ASC
        LIMIT $3;
        `,
      [companyId.trim(), searchText, parseSupplierLimit(req.query.limit)],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/suppliers/variant-sources
//
// targetBranchId لا يستخدم branchId حتى يستطيع
// مدير الشركة اختيار فرع مستهدف دون أن يحذفه
// Tenant Middleware.
//
// عند تحديد فرع:
// - يعرض مصادر الفرع.
// - يعرض أيضًا المصادر العامة للشركة كـ fallback.
// ======================================================
suppliersRouter.get(
  '/api/suppliers/variant-sources',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const requestedBranchId =
        typeof req.query.targetBranchId === 'string'
          ? req.query.targetBranchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !isSupplierSourceUuid(requestedBranchId)) {
        return res.status(400).json({
          error: 'targetBranchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'The requested branch is outside the authenticated scope',
        })
      }

      const effectiveBranchId = auth.branchId || requestedBranchId || null

      if (effectiveBranchId) {
        const branchResult = await db.query(
          `
            SELECT id

            FROM branches

            WHERE company_id = $1
              AND id = $2

            LIMIT 1;
            `,
          [auth.companyId, effectiveBranchId],
        )

        if ((branchResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'Branch was not found in the authenticated company',
          })
        }
      }

      const variantId =
        typeof req.query.variantId === 'string'
          ? req.query.variantId.trim().toLowerCase()
          : ''

      if (variantId && !isSupplierSourceUuid(variantId)) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      const supplierId =
        typeof req.query.supplierId === 'string'
          ? req.query.supplierId.trim().toLowerCase()
          : ''

      if (supplierId && !isSupplierSourceUuid(supplierId)) {
        return res.status(400).json({
          error: 'supplierId is invalid',
        })
      }

      const includeInactive = req.query.includeInactive === 'true'

      const limit = parseSupplierLimit(req.query.limit)

      const result = await db.query(
        `
          SELECT
            source.*,

            branch.code
              AS branch_code,

            branch.name
              AS branch_name,

            supplier.name
              AS supplier_name,

            supplier.code
              AS supplier_code,

            supplier.is_active
              AS supplier_is_active,

            variant.product_id,
            variant.sku,
            variant.primary_barcode,
            variant.status
              AS variant_status,

            product.name
              AS product_name,

            product.status
              AS product_status,

            size.name
              AS size_name,

            color.name
              AS color_name

          FROM supplier_variant_sources
               source

          JOIN suppliers supplier
            ON supplier.company_id =
               source.company_id

            AND supplier.id =
                source.supplier_id

          JOIN product_variants
               variant
            ON variant.company_id =
               source.company_id

            AND variant.id =
                source.variant_id

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

          LEFT JOIN branches branch
            ON branch.company_id =
               source.company_id

            AND branch.id =
                source.branch_id

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

          WHERE source.company_id = $1

            AND (
              (
                $2::uuid IS NULL
                AND source.branch_id
                    IS NULL
              )

              OR (
                $2::uuid IS NOT NULL

                AND (
                  source.branch_id =
                    $2::uuid

                  OR source.branch_id
                     IS NULL
                )
              )
            )

            AND (
              $3::uuid IS NULL
              OR source.variant_id =
                 $3::uuid
            )

            AND (
              $4::uuid IS NULL
              OR source.supplier_id =
                 $4::uuid
            )

            AND (
              $5::boolean = TRUE
              OR source.is_active =
                 TRUE
            )

          ORDER BY
            product.name ASC,
            variant.sku ASC,

            CASE
              WHEN source.branch_id
                   IS NOT DISTINCT FROM
                   $2::uuid
              THEN 0
              ELSE 1
            END ASC,

            source.is_preferred DESC,
            supplier.name ASC

          LIMIT $6;
          `,
        [
          auth.companyId,
          effectiveBranchId,
          variantId || null,
          supplierId || null,
          includeInactive,
          limit,
        ],
      )

      return res.json({
        data: (result.rows as Array<Record<string, unknown>>).map(
          mapSupplierVariantSource,
        ),

        meta: {
          targetBranchId: effectiveBranchId,

          branchSelectionLocked: Boolean(auth.branchId),

          includesCompanyFallback: Boolean(effectiveBranchId),

          limit,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/suppliers/variant-sources/resolve
//
// ترتيب الاختيار:
// 1. المورد المفضل للفرع.
// 2. المورد المفضل العام للشركة.
// 3. مصدر فرع نشط غير مفضل.
// 4. مصدر عام نشط غير مفضل.
// ======================================================
suppliersRouter.get(
  '/api/suppliers/variant-sources/resolve',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const variantId =
        typeof req.query.variantId === 'string'
          ? req.query.variantId.trim().toLowerCase()
          : ''

      if (!variantId || !isSupplierSourceUuid(variantId)) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      const requestedBranchId =
        typeof req.query.targetBranchId === 'string'
          ? req.query.targetBranchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !isSupplierSourceUuid(requestedBranchId)) {
        return res.status(400).json({
          error: 'targetBranchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'The requested branch is outside the authenticated scope',
        })
      }

      const effectiveBranchId = auth.branchId || requestedBranchId || null

      const result = await db.query(
        `
          SELECT
            source.*,

            branch.code
              AS branch_code,

            branch.name
              AS branch_name,

            supplier.name
              AS supplier_name,

            supplier.code
              AS supplier_code,

            supplier.is_active
              AS supplier_is_active,

            variant.product_id,
            variant.sku,
            variant.primary_barcode,

            variant.status
              AS variant_status,

            product.name
              AS product_name,

            product.status
              AS product_status,

            size.name
              AS size_name,

            color.name
              AS color_name

          FROM supplier_variant_sources
               source

          JOIN suppliers supplier
            ON supplier.company_id =
               source.company_id

            AND supplier.id =
                source.supplier_id

            AND supplier.is_active =
                TRUE

          JOIN product_variants
               variant
            ON variant.company_id =
               source.company_id

            AND variant.id =
                source.variant_id

            AND variant.status =
                'active'

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

            AND product.status =
                'active'

          LEFT JOIN branches branch
            ON branch.company_id =
               source.company_id

            AND branch.id =
                source.branch_id

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

          WHERE source.company_id = $1
            AND source.variant_id = $2
            AND source.is_active = TRUE

            AND (
              (
                $3::uuid IS NULL
                AND source.branch_id
                    IS NULL
              )

              OR (
                $3::uuid IS NOT NULL

                AND (
                  source.branch_id =
                    $3::uuid

                  OR source.branch_id
                     IS NULL
                )
              )
            )

          ORDER BY
            CASE
              WHEN $3::uuid IS NOT NULL
               AND source.branch_id =
                   $3::uuid
               AND source.is_preferred =
                   TRUE
              THEN 1

              WHEN source.branch_id
                   IS NULL
               AND source.is_preferred =
                   TRUE
              THEN 2

              WHEN $3::uuid IS NOT NULL
               AND source.branch_id =
                   $3::uuid
              THEN 3

              ELSE 4
            END ASC,

            source.default_unit_cost
              ASC NULLS LAST,

            supplier.name ASC

          LIMIT 1;
          `,
        [auth.companyId, variantId, effectiveBranchId],
      )

      const selectedRow = result.rows[0] as Record<string, unknown> | undefined

      return res.json({
        data: selectedRow ? mapSupplierVariantSource(selectedRow) : null,

        meta: {
          targetBranchId: effectiveBranchId,

          resolved: Boolean(selectedRow),
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// PUT /api/suppliers/variant-sources
//
// Upsert حسب:
// company + target branch + supplier + variant
//
// targetBranchId:
// - null = إعداد عام للشركة.
// - UUID = إعداد خاص بفرع.
//
// مستخدم الفرع يتم فرض فرعه عليه.
// ======================================================
suppliersRouter.put(
  '/api/suppliers/variant-sources',

  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const {
        targetBranchId,
        supplierId,
        variantId,
        supplierSku,
        defaultUnitCost,
        minimumOrderQuantity,
        orderMultiple,
        leadTimeDays,
        isPreferred,
        isActive,
      } = req.body

      const requestedBranchId =
        typeof targetBranchId === 'string' && targetBranchId.trim()
          ? targetBranchId.trim().toLowerCase()
          : null

      if (requestedBranchId && !isSupplierSourceUuid(requestedBranchId)) {
        return res.status(400).json({
          error: 'targetBranchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'The requested branch is outside the authenticated scope',
        })
      }

      const effectiveBranchId = auth.branchId || requestedBranchId || null

      if (
        typeof supplierId !== 'string' ||
        !isSupplierSourceUuid(supplierId.trim())
      ) {
        return res.status(400).json({
          error: 'supplierId is invalid',
        })
      }

      if (
        typeof variantId !== 'string' ||
        !isSupplierSourceUuid(variantId.trim())
      ) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      if (
        supplierSku !== undefined &&
        supplierSku !== null &&
        typeof supplierSku !== 'string'
      ) {
        return res.status(400).json({
          error: 'supplierSku must be text or null',
        })
      }

      const normalizedSupplierSku =
        typeof supplierSku === 'string' && supplierSku.trim()
          ? supplierSku.trim()
          : null

      if (normalizedSupplierSku && normalizedSupplierSku.length > 120) {
        return res.status(400).json({
          error: 'supplierSku cannot exceed 120 characters',
        })
      }

      const normalizedCost =
        defaultUnitCost === null ||
        defaultUnitCost === undefined ||
        defaultUnitCost === ''
          ? null
          : roundSupplierMoney(Number(defaultUnitCost))

      if (
        normalizedCost !== null &&
        (!Number.isFinite(normalizedCost) || normalizedCost < 0)
      ) {
        return res.status(400).json({
          error: 'defaultUnitCost is invalid',
        })
      }

      const normalizedMinimum = roundSupplierQuantity(
        Number(minimumOrderQuantity ?? 1),
      )

      if (!Number.isFinite(normalizedMinimum) || normalizedMinimum <= 0) {
        return res.status(400).json({
          error: 'minimumOrderQuantity must be greater than zero',
        })
      }

      const normalizedMultiple = roundSupplierQuantity(
        Number(orderMultiple ?? 1),
      )

      if (!Number.isFinite(normalizedMultiple) || normalizedMultiple <= 0) {
        return res.status(400).json({
          error: 'orderMultiple must be greater than zero',
        })
      }

      const normalizedLeadTime = Number(leadTimeDays ?? 0)

      if (
        !Number.isInteger(normalizedLeadTime) ||
        normalizedLeadTime < 0 ||
        normalizedLeadTime > 3650
      ) {
        return res.status(400).json({
          error: 'leadTimeDays must be an integer between 0 and 3650',
        })
      }

      if (isPreferred !== undefined && typeof isPreferred !== 'boolean') {
        return res.status(400).json({
          error: 'isPreferred must be boolean',
        })
      }

      if (isActive !== undefined && typeof isActive !== 'boolean') {
        return res.status(400).json({
          error: 'isActive must be boolean',
        })
      }

      const preferredValue =
        typeof isPreferred === 'boolean' ? isPreferred : false

      const activeValue = typeof isActive === 'boolean' ? isActive : true

      if (preferredValue && !activeValue) {
        return res.status(400).json({
          error: 'An inactive source cannot be preferred',
        })
      }

      await client.query('BEGIN')

      if (effectiveBranchId) {
        const branchResult = await client.query(
          `
            SELECT id

            FROM branches

            WHERE company_id = $1
              AND id = $2
              AND is_active = TRUE

            FOR SHARE;
            `,
          [auth.companyId, effectiveBranchId],
        )

        if ((branchResult.rowCount ?? 0) === 0) {
          throw new SupplierSourceApiError(
            404,
            'Branch was not found or inactive',
          )
        }
      }

      const supplierResult = await client.query(
        `
          SELECT id

          FROM suppliers

          WHERE company_id = $1
            AND id = $2
            AND is_active = TRUE

          FOR SHARE;
          `,
        [auth.companyId, supplierId.trim()],
      )

      if ((supplierResult.rowCount ?? 0) === 0) {
        throw new SupplierSourceApiError(
          404,
          'Supplier was not found or inactive',
        )
      }

      const variantResult = await client.query(
        `
          SELECT
            variant.id

          FROM product_variants
               variant

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

          WHERE variant.company_id = $1
            AND variant.id = $2
            AND variant.status =
                'active'

            AND product.status =
                'active'

          FOR SHARE OF variant,
                       product;
          `,
        [auth.companyId, variantId.trim()],
      )

      if ((variantResult.rowCount ?? 0) === 0) {
        throw new SupplierSourceApiError(
          404,
          'Product variant was not found or inactive',
        )
      }

      const oldSourceResult = await client.query(
        `
          SELECT *

          FROM supplier_variant_sources

          WHERE company_id = $1

            AND branch_id
                IS NOT DISTINCT FROM
                $2::uuid

            AND supplier_id = $3
            AND variant_id = $4

          FOR UPDATE;
          `,
        [
          auth.companyId,
          effectiveBranchId,
          supplierId.trim(),
          variantId.trim(),
        ],
      )

      const oldSource = oldSourceResult.rows[0] ?? null

      let demotedRows: Array<Record<string, unknown>> = []

      if (preferredValue && activeValue) {
        const demotedResult = await client.query(
          `
            UPDATE
              supplier_variant_sources

            SET
              is_preferred = FALSE,
              updated_by = $5,
              updated_at = NOW()

            WHERE company_id = $1

              AND branch_id
                  IS NOT DISTINCT FROM
                  $2::uuid

              AND variant_id = $3
              AND supplier_id <> $4

              AND is_preferred = TRUE
              AND is_active = TRUE

            RETURNING *;
            `,
          [
            auth.companyId,
            effectiveBranchId,
            variantId.trim(),
            supplierId.trim(),
            auth.userId,
          ],
        )

        demotedRows = demotedResult.rows
      }

      const commonValues = [
        auth.companyId,
        effectiveBranchId,
        supplierId.trim(),
        variantId.trim(),
        normalizedSupplierSku,
        normalizedCost,
        normalizedMinimum,
        normalizedMultiple,
        normalizedLeadTime,
        preferredValue,
        activeValue,
        auth.userId,
      ]

      const savedResult = effectiveBranchId
        ? await client.query(
            `
              INSERT INTO
                supplier_variant_sources (
                  company_id,
                  branch_id,
                  supplier_id,
                  variant_id,

                  supplier_sku,
                  default_unit_cost,
                  minimum_order_quantity,
                  order_multiple,
                  lead_time_days,

                  is_preferred,
                  is_active,

                  created_by,
                  updated_by
                )
              VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8, $9,
                $10, $11,
                $12, $12
              )

              ON CONFLICT (
                company_id,
                branch_id,
                supplier_id,
                variant_id
              )
              WHERE branch_id
                    IS NOT NULL

              DO UPDATE SET
                supplier_sku =
                  EXCLUDED
                    .supplier_sku,

                default_unit_cost =
                  EXCLUDED
                    .default_unit_cost,

                minimum_order_quantity =
                  EXCLUDED
                    .minimum_order_quantity,

                order_multiple =
                  EXCLUDED
                    .order_multiple,

                lead_time_days =
                  EXCLUDED
                    .lead_time_days,

                is_preferred =
                  EXCLUDED
                    .is_preferred,

                is_active =
                  EXCLUDED.is_active,

                updated_by =
                  EXCLUDED.updated_by,

                updated_at = NOW()

              RETURNING *;
              `,
            commonValues,
          )
        : await client.query(
            `
              INSERT INTO
                supplier_variant_sources (
                  company_id,
                  branch_id,
                  supplier_id,
                  variant_id,

                  supplier_sku,
                  default_unit_cost,
                  minimum_order_quantity,
                  order_multiple,
                  lead_time_days,

                  is_preferred,
                  is_active,

                  created_by,
                  updated_by
                )
              VALUES (
                $1, NULL, $3, $4,
                $5, $6, $7, $8, $9,
                $10, $11,
                $12, $12
              )

              ON CONFLICT (
                company_id,
                supplier_id,
                variant_id
              )
              WHERE branch_id IS NULL

              DO UPDATE SET
                supplier_sku =
                  EXCLUDED
                    .supplier_sku,

                default_unit_cost =
                  EXCLUDED
                    .default_unit_cost,

                minimum_order_quantity =
                  EXCLUDED
                    .minimum_order_quantity,

                order_multiple =
                  EXCLUDED
                    .order_multiple,

                lead_time_days =
                  EXCLUDED
                    .lead_time_days,

                is_preferred =
                  EXCLUDED
                    .is_preferred,

                is_active =
                  EXCLUDED.is_active,

                updated_by =
                  EXCLUDED.updated_by,

                updated_at = NOW()

              RETURNING *;
              `,
            commonValues,
          )

      const savedSource = savedResult.rows[0]

      for (const demotedSource of demotedRows) {
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
            $7::jsonb,
            $8::jsonb,
            $9, $10
          );
          `,
          [
            auth.companyId,
            effectiveBranchId,
            auth.userId,

            'suppliers.variant_source.preference_cleared',
            'supplier_variant_source',
            demotedSource.id,

            JSON.stringify({
              ...demotedSource,
              is_preferred: true,
            }),

            JSON.stringify(demotedSource),

            req.ip || null,
            req.get('user-agent') || null,
          ],
        )
      }

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
          $7::jsonb,
          $8::jsonb,
          $9, $10
        );
        `,
        [
          auth.companyId,
          effectiveBranchId,
          auth.userId,

          oldSource
            ? 'suppliers.variant_source.updated'
            : 'suppliers.variant_source.created',

          'supplier_variant_source',
          savedSource.id,

          oldSource ? JSON.stringify(oldSource) : null,

          JSON.stringify(savedSource),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      const detailsResult = await client.query(
        `
          SELECT
            source.*,

            branch.code
              AS branch_code,

            branch.name
              AS branch_name,

            supplier.name
              AS supplier_name,

            supplier.code
              AS supplier_code,

            supplier.is_active
              AS supplier_is_active,

            variant.product_id,
            variant.sku,
            variant.primary_barcode,
            variant.status
              AS variant_status,

            product.name
              AS product_name,

            product.status
              AS product_status,

            size.name
              AS size_name,

            color.name
              AS color_name

          FROM supplier_variant_sources
               source

          JOIN suppliers supplier
            ON supplier.company_id =
               source.company_id

            AND supplier.id =
                source.supplier_id

          JOIN product_variants
               variant
            ON variant.company_id =
               source.company_id

            AND variant.id =
                source.variant_id

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

          LEFT JOIN branches branch
            ON branch.company_id =
               source.company_id

            AND branch.id =
                source.branch_id

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

          WHERE source.id = $1

          LIMIT 1;
          `,
        [savedSource.id],
      )

      await client.query('COMMIT')

      return res.status(oldSource ? 200 : 201).json({
        data: mapSupplierVariantSource(detailsResult.rows[0]),
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof SupplierSourceApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      if (isPostgresUniqueViolation(error)) {
        return res.status(409).json({
          error: 'يوجد مورد مفضل آخر أو إعداد توريد مكرر لنفس النطاق.',
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// POST /api/suppliers
//
// إنشاء مورد جديد داخل الشركة الموثقة.
// ======================================================
suppliersRouter.post('/api/suppliers', async (req, res, next) => {
  try {
    const { companyId, name, code, phone, email, address, taxNumber } = req.body

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId is required',
      })
    }

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        error: 'Supplier name is required',
      })
    }

    const supplierCode =
      typeof code === 'string' && code.trim()
        ? code.trim().toUpperCase()
        : `SUP-${randomUUID().slice(0, 8).toUpperCase()}`

    const result = await db.query(
      `
        INSERT INTO suppliers (
          company_id,
          name,
          code,
          phone,
          email,
          address,
          tax_number,
          is_active
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, TRUE
        )
        RETURNING *;
        `,
      [
        companyId.trim(),
        name.trim(),
        supplierCode,
        typeof phone === 'string' && phone.trim() ? phone.trim() : null,
        typeof email === 'string' && email.trim() ? email.trim() : null,
        typeof address === 'string' && address.trim() ? address.trim() : null,
        typeof taxNumber === 'string' && taxNumber.trim()
          ? taxNumber.trim()
          : null,
      ],
    )

    return res.status(201).json({
      data: result.rows[0],
    })
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      return res.status(409).json({
        error: 'كود المورد مستخدم بالفعل.',
      })
    }

    return next(error)
  }
})

// ======================================================
// PATCH /api/suppliers/:supplierId
//
// تعديل بيانات مورد داخل الشركة الموثقة.
// ======================================================
suppliersRouter.patch('/api/suppliers/:supplierId', async (req, res, next) => {
  try {
    const supplierId = String(req.params.supplierId || '').trim()

    const {
      companyId,
      name,
      code,
      phone,
      email,
      address,
      taxNumber,
      isActive,
    } = req.body

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId is required',
      })
    }

    if (!supplierId) {
      return res.status(400).json({
        error: 'supplierId is required',
      })
    }

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        error: 'Supplier name is required',
      })
    }

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({
        error: 'Supplier code is required',
      })
    }

    const result = await db.query(
      `
        UPDATE suppliers
        SET
          name = $1,
          code = $2,
          phone = $3,
          email = $4,
          address = $5,
          tax_number = $6,
          is_active = $7,
          updated_at = NOW()
        WHERE company_id = $8
          AND id = $9
        RETURNING *;
        `,
      [
        name.trim(),
        code.trim().toUpperCase(),
        typeof phone === 'string' && phone.trim() ? phone.trim() : null,
        typeof email === 'string' && email.trim() ? email.trim() : null,
        typeof address === 'string' && address.trim() ? address.trim() : null,
        typeof taxNumber === 'string' && taxNumber.trim()
          ? taxNumber.trim()
          : null,
        typeof isActive === 'boolean' ? isActive : true,
        companyId.trim(),
        supplierId,
      ],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({
        error: 'Supplier was not found',
      })
    }

    return res.json({
      data: result.rows[0],
    })
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      return res.status(409).json({
        error: 'كود المورد مستخدم بالفعل.',
      })
    }

    return next(error)
  }
})
