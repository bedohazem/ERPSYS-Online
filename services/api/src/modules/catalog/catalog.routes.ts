import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const catalogRouter = Router()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

catalogRouter.get('/api/catalog/sizes', async (req, res, next) => {
  try {
    const companyId = req.query.companyId

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    const result = await db.query(
      `
      SELECT id, name, code, sort_order, is_active
      FROM fashion_sizes
      WHERE company_id = $1
      ORDER BY sort_order ASC, name ASC;
      `,
      [companyId],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/api/catalog/colors', async (req, res, next) => {
  try {
    const companyId = req.query.companyId

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    const result = await db.query(
      `
      SELECT id, name, code, hex_code, is_active
      FROM fashion_colors
      WHERE company_id = $1
      ORDER BY name ASC;
      `,
      [companyId],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/api/catalog/products', async (req, res, next) => {
  try {
    const companyId = req.query.companyId

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    const result = await db.query(
      `
      SELECT
        p.id,
        p.name,
        p.description,
        p.product_type,
        p.base_sku,
        p.base_price,
        p.cost_price,
        p.tax_rate,
        p.status,
        pc.name AS category_name,
        b.name AS brand_name,
        COUNT(pv.id)::int AS variants_count
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN product_variants pv ON pv.product_id = p.id
      WHERE p.company_id = $1
      GROUP BY p.id, pc.name, b.name
      ORDER BY p.created_at DESC;
      `,
      [companyId],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

catalogRouter.get('/api/catalog/variants', async (req, res, next) => {
  try {
    const companyId = req.query.companyId

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    const result = await db.query(
      `
      SELECT
        pv.id,
        pv.product_id,
        p.name AS product_name,
        pv.sku,
        pv.style_code,
        pv.primary_barcode,
        pv.cost_price,
        pv.selling_price,
        pv.status,
        fs.name AS size_name,
        fs.code AS size_code,
        fc.name AS color_name,
        fc.code AS color_code,
        fse.name AS season_name,
        fco.name AS collection_name
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
      LEFT JOIN fashion_colors fc ON fc.id = pv.color_id
      LEFT JOIN fashion_seasons fse ON fse.id = pv.season_id
      LEFT JOIN fashion_collections fco ON fco.id = pv.collection_id
      WHERE pv.company_id = $1
      ORDER BY p.name ASC, pv.sku ASC;
      `,
      [companyId],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

catalogRouter.post('/api/catalog/products', async (req, res, next) => {
  try {
    const {
      companyId,
      categoryId,
      brandId,
      name,
      description,
      productType,
      baseSku,
      basePrice,
      costPrice,
      taxRate,
    } = req.body

    if (!companyId || typeof companyId !== 'string') {
      return res.status(400).json({ error: 'companyId is required' })
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Product name is required' })
    }

    const result = await db.query(
      `
      INSERT INTO products (
        company_id,
        category_id,
        brand_id,
        name,
        description,
        product_type,
        base_sku,
        base_price,
        cost_price,
        tax_rate
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING
        id,
        company_id,
        category_id,
        brand_id,
        name,
        description,
        product_type,
        base_sku,
        base_price,
        cost_price,
        tax_rate,
        status,
        created_at,
        updated_at;
      `,
      [
        companyId,
        categoryId || null,
        brandId || null,
        name.trim(),
        description || null,
        productType || 'fashion',
        baseSku || null,
        Number(basePrice || 0),
        Number(costPrice || 0),
        Number(taxRate || 0),
      ],
    )

    res.status(201).json({ data: result.rows[0] })
  } catch (error) {
    next(error)
  }
})

catalogRouter.post('/api/catalog/variants', async (req, res, next) => {
  try {
    const {
      companyId,
      productId,
      sizeId,
      colorId,
      seasonId,
      collectionId,
      sku,
      styleCode,
      primaryBarcode,
      costPrice,
      sellingPrice,
    } = req.body

    if (!companyId || typeof companyId !== 'string') {
      return res.status(400).json({ error: 'companyId is required' })
    }

    if (!productId || typeof productId !== 'string') {
      return res.status(400).json({ error: 'productId is required' })
    }

    if (!sku || typeof sku !== 'string') {
      return res.status(400).json({ error: 'Variant SKU is required' })
    }

    const result = await db.query(
      `
      INSERT INTO product_variants (
        company_id,
        product_id,
        size_id,
        color_id,
        season_id,
        collection_id,
        sku,
        style_code,
        primary_barcode,
        cost_price,
        selling_price
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING
        id,
        company_id,
        product_id,
        size_id,
        color_id,
        season_id,
        collection_id,
        sku,
        style_code,
        primary_barcode,
        cost_price,
        selling_price,
        status,
        created_at,
        updated_at;
      `,
      [
        companyId,
        productId,
        sizeId || null,
        colorId || null,
        seasonId || null,
        collectionId || null,
        sku.trim(),
        styleCode || null,
        primaryBarcode || null,
        Number(costPrice || 0),
        Number(sellingPrice || 0),
      ],
    )

    const variant = result.rows[0]

    if (primaryBarcode) {
      await db.query(
        `
        INSERT INTO variant_barcodes (
          company_id,
          variant_id,
          barcode,
          barcode_type,
          is_primary
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (company_id, barcode) DO NOTHING;
        `,
        [companyId, variant.id, primaryBarcode, 'default', true],
      )
    }

    res.status(201).json({ data: variant })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// PATCH /api/catalog/variants/:variantId/price
//
// Body:
// {
//   sellingPrice: number,
//   note?: string
// }
// ======================================================
catalogRouter.patch(
  '/api/catalog/variants/:variantId/price',

  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const rawVariantId = req.params.variantId

      const variantId = Array.isArray(rawVariantId)
        ? rawVariantId[0]
        : rawVariantId

      if (typeof variantId !== 'string' || !uuidPattern.test(variantId)) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      const sellingPrice = roundMoney(Number(req.body?.sellingPrice))

      if (
        !Number.isFinite(sellingPrice) ||
        sellingPrice < 0 ||
        sellingPrice > 999_999_999_999
      ) {
        return res.status(400).json({
          error: 'sellingPrice must be a valid non-negative amount',
        })
      }

      const note =
        typeof req.body?.note === 'string' && req.body.note.trim()
          ? req.body.note.trim().slice(0, 500)
          : null

      await client.query('BEGIN')

      const variantResult = await client.query(
        `
          SELECT
            pv.id,
            pv.company_id,
            pv.product_id,
            pv.sku,
            pv.selling_price,
            pv.status,

            p.name
              AS product_name

          FROM product_variants pv

          JOIN products p
            ON p.id =
               pv.product_id
            AND p.company_id =
                pv.company_id

          WHERE pv.company_id = $1
            AND pv.id = $2

          FOR UPDATE OF pv;
          `,
        [auth.companyId, variantId],
      )

      if ((variantResult.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Product variant was not found',
        })
      }

      const variant = variantResult.rows[0]

      const oldSellingPrice = roundMoney(Number(variant.selling_price))

      if (oldSellingPrice === sellingPrice) {
        await client.query('COMMIT')

        return res.json({
          changed: false,

          data: {
            ...variant,

            selling_price: sellingPrice.toFixed(2),
          },
        })
      }

      const updatedResult = await client.query(
        `
          UPDATE product_variants

          SET
            selling_price = $1,
            updated_at = NOW()

          WHERE company_id = $2
            AND id = $3

          RETURNING
            id,
            company_id,
            product_id,
            sku,
            selling_price,
            status,
            updated_at;
          `,
        [sellingPrice, auth.companyId, variantId],
      )

      await client.query(
        `
        INSERT INTO
          product_variant_price_history (
            company_id,
            variant_id,

            old_selling_price,
            new_selling_price,

            changed_by,
            change_note
          )
        VALUES (
          $1, $2,
          $3, $4,
          $5, $6
        );
        `,
        [
          auth.companyId,
          variantId,

          oldSellingPrice,
          sellingPrice,

          auth.userId,
          note,
        ],
      )

      await client.query('COMMIT')

      return res.json({
        changed: true,

        data: {
          ...updatedResult.rows[0],

          product_name: variant.product_name,

          old_selling_price: oldSellingPrice.toFixed(2),
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
