import { Router } from "express";
import { db } from "../../db/pool";

export const inventoryRouter = Router();

inventoryRouter.get("/api/inventory/stock-balances", async (req, res, next) => {
  try {
    const companyId = req.query.companyId;

    if (typeof companyId !== "string" || !companyId.trim()) {
      return res.status(400).json({ error: "companyId query parameter is required" });
    }

    const result = await db.query(
      `
      SELECT
        sb.id,
        sb.company_id,
        sb.branch_id,
        sb.stock_location_id,
        sl.name AS stock_location_name,
        sl.code AS stock_location_code,
        sl.location_type,
        sb.variant_id,
        pv.sku,
        pv.primary_barcode,
        p.name AS product_name,
        fs.name AS size_name,
        fc.name AS color_name,
        sb.quantity,
        sb.updated_at
      FROM stock_balances sb
      JOIN stock_locations sl ON sl.id = sb.stock_location_id
      JOIN product_variants pv ON pv.id = sb.variant_id
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
      LEFT JOIN fashion_colors fc ON fc.id = pv.color_id
      WHERE sb.company_id = $1
      ORDER BY p.name ASC, pv.sku ASC, sl.name ASC;
      `,
      [companyId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.post("/api/inventory/opening-balance", async (req, res, next) => {
  const client = await db.connect();

  try {
    const {
      companyId,
      branchId,
      stockLocationId,
      variantId,
      quantity,
      note,
      createdBy,
    } = req.body;

    if (!companyId || typeof companyId !== "string") {
      return res.status(400).json({ error: "companyId is required" });
    }

    if (!stockLocationId || typeof stockLocationId !== "string") {
      return res.status(400).json({ error: "stockLocationId is required" });
    }

    if (!variantId || typeof variantId !== "string") {
      return res.status(400).json({ error: "variantId is required" });
    }

    const numericQuantity = Number(quantity);

    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({ error: "quantity must be greater than zero" });
    }

    await client.query("BEGIN");

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
      ON CONFLICT (company_id, stock_location_id, variant_id) DO NOTHING;
      `,
      [companyId, branchId || null, stockLocationId, variantId]
    );

    const balanceBeforeResult = await client.query(
      `
      SELECT quantity
      FROM stock_balances
      WHERE company_id = $1
        AND stock_location_id = $2
        AND variant_id = $3
      FOR UPDATE;
      `,
      [companyId, stockLocationId, variantId]
    );

    if (balanceBeforeResult.rowCount === 0) {
      throw new Error("Stock balance row was not found after insert");
    }

    const quantityBefore = Number(balanceBeforeResult.rows[0].quantity);
    const quantityAfter = quantityBefore + numericQuantity;

    const balanceResult = await client.query(
      `
      UPDATE stock_balances
      SET
        quantity = $1,
        branch_id = $2,
        updated_at = NOW()
      WHERE company_id = $3
        AND stock_location_id = $4
        AND variant_id = $5
      RETURNING id, company_id, branch_id, stock_location_id, variant_id, quantity, updated_at;
      `,
      [quantityAfter, branchId || null, companyId, stockLocationId, variantId]
    );

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
      VALUES ($1, $2, $3, $4, 'adjustment', $5, $6, $7, 'opening_balance', NULL, $8, $9)
      RETURNING
        id,
        company_id,
        branch_id,
        stock_location_id,
        variant_id,
        movement_type,
        quantity,
        quantity_before,
        quantity_after,
        reference_type,
        note,
        created_at;
      `,
      [
        companyId,
        branchId || null,
        stockLocationId,
        variantId,
        numericQuantity,
        quantityBefore,
        quantityAfter,
        note || "Opening balance",
        createdBy || null,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      data: {
        balance: balanceResult.rows[0],
        movement: movementResult.rows[0],
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});