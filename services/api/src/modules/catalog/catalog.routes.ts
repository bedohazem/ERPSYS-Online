import { Router } from "express";
import { db } from "../../db/pool";

export const catalogRouter = Router();

catalogRouter.get("/api/catalog/sizes", async (req, res, next) => {
  try {
    const companyId = req.query.companyId;

    if (typeof companyId !== "string" || !companyId.trim()) {
      return res.status(400).json({ error: "companyId query parameter is required" });
    }

    const result = await db.query(
      `
      SELECT id, name, code, sort_order, is_active
      FROM fashion_sizes
      WHERE company_id = $1
      ORDER BY sort_order ASC, name ASC;
      `,
      [companyId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/api/catalog/colors", async (req, res, next) => {
  try {
    const companyId = req.query.companyId;

    if (typeof companyId !== "string" || !companyId.trim()) {
      return res.status(400).json({ error: "companyId query parameter is required" });
    }

    const result = await db.query(
      `
      SELECT id, name, code, hex_code, is_active
      FROM fashion_colors
      WHERE company_id = $1
      ORDER BY name ASC;
      `,
      [companyId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/api/catalog/products", async (req, res, next) => {
  try {
    const companyId = req.query.companyId;

    if (typeof companyId !== "string" || !companyId.trim()) {
      return res.status(400).json({ error: "companyId query parameter is required" });
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
      [companyId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

catalogRouter.get("/api/catalog/variants", async (req, res, next) => {
  try {
    const companyId = req.query.companyId;

    if (typeof companyId !== "string" || !companyId.trim()) {
      return res.status(400).json({ error: "companyId query parameter is required" });
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
      [companyId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});