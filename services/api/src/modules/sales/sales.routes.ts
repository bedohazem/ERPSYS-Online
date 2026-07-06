import { Router } from "express";
import { db } from "../../db/pool";

export const salesRouter = Router();

salesRouter.post("/api/sales", async (req, res, next) => {
  const client = await db.connect();

  try {
    const {
      companyId,
      branchId,
      stockLocationId,
      cashierId,
      shiftId,
      customerId,
      saleNumber,
      source,
      localSaleId,
      idempotencyKey,
      items,
      payments,
      discountTotal,
      taxTotal,
    } = req.body;

    if (!companyId || typeof companyId !== "string") {
      return res.status(400).json({ error: "companyId is required" });
    }

    if (!branchId || typeof branchId !== "string") {
      return res.status(400).json({ error: "branchId is required" });
    }

    if (!stockLocationId || typeof stockLocationId !== "string") {
      return res.status(400).json({ error: "stockLocationId is required" });
    }

    if (!saleNumber || typeof saleNumber !== "string") {
      return res.status(400).json({ error: "saleNumber is required" });
    }

    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return res.status(400).json({ error: "idempotencyKey is required" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items are required" });
    }

    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: "payments are required" });
    }

    await client.query("BEGIN");

    const existingSale = await client.query(
      `
      SELECT id, sale_number, total, status
      FROM sales
      WHERE company_id = $1
        AND idempotency_key = $2;
      `,
      [companyId, idempotencyKey]
    );

    if ((existingSale.rowCount ?? 0) > 0) {
      await client.query("COMMIT");

      return res.status(200).json({
        duplicated: true,
        data: existingSale.rows[0],
      });
    }

    let subtotal = 0;

    const preparedItems = [];

    for (const item of items) {
      const variantId = item.variantId;
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      const itemDiscount = Number(item.discountAmount || 0);
      const itemTax = Number(item.taxAmount || 0);

      if (!variantId || typeof variantId !== "string") {
        throw new Error("variantId is required for each item");
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("quantity must be greater than zero");
      }

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error("unitPrice must be zero or greater");
      }

      const variantResult = await client.query(
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
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
        LEFT JOIN fashion_colors fc ON fc.id = pv.color_id
        WHERE pv.company_id = $1
          AND pv.id = $2
          AND pv.status = 'active';
        `,
        [companyId, variantId]
      );

      if ((variantResult.rowCount ?? 0) === 0) {
        throw new Error(`Variant not found or inactive: ${variantId}`);
      }

      const variant = variantResult.rows[0];
      const lineTotal = quantity * unitPrice - itemDiscount + itemTax;

      subtotal += quantity * unitPrice;

      preparedItems.push({
        variantId,
        quantity,
        unitPrice,
        discountAmount: itemDiscount,
        taxAmount: itemTax,
        lineTotal,
        skuSnapshot: variant.sku,
        barcodeSnapshot: variant.primary_barcode,
        productNameSnapshot: variant.product_name,
        sizeSnapshot: variant.size_name,
        colorSnapshot: variant.color_name,
      });
    }

    const finalDiscountTotal = Number(discountTotal || 0);
    const finalTaxTotal = Number(taxTotal || 0);
    const total = subtotal - finalDiscountTotal + finalTaxTotal;

    const paidTotal = payments.reduce((sum: number, payment: any) => {
      return sum + Number(payment.amount || 0);
    }, 0);

    const changeTotal = Math.max(paidTotal - total, 0);

    const saleResult = await client.query(
      `
      INSERT INTO sales (
        company_id,
        branch_id,
        stock_location_id,
        cashier_id,
        shift_id,
        customer_id,
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
        synced_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        'completed',
        CASE WHEN $8 = 'offline_pos' THEN NOW() ELSE NULL END
      )
      RETURNING *;
      `,
      [
        companyId,
        branchId,
        stockLocationId,
        cashierId || null,
        shiftId || null,
        customerId || null,
        saleNumber.trim(),
        source || "online_pos",
        localSaleId || null,
        idempotencyKey,
        subtotal,
        finalDiscountTotal,
        finalTaxTotal,
        total,
        paidTotal,
        changeTotal,
      ]
    );

    const sale = saleResult.rows[0];

    const createdItems = [];

    for (const item of preparedItems) {
      const saleItemResult = await client.query(
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
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13
        )
        RETURNING *;
        `,
        [
          companyId,
          sale.id,
          item.variantId,
          item.skuSnapshot,
          item.barcodeSnapshot,
          item.productNameSnapshot,
          item.sizeSnapshot,
          item.colorSnapshot,
          item.quantity,
          item.unitPrice,
          item.discountAmount,
          item.taxAmount,
          item.lineTotal,
        ]
      );

      createdItems.push(saleItemResult.rows[0]);

      const balanceResult = await client.query(
        `
        SELECT quantity
        FROM stock_balances
        WHERE company_id = $1
          AND stock_location_id = $2
          AND variant_id = $3
        FOR UPDATE;
        `,
        [companyId, stockLocationId, item.variantId]
      );

      const quantityBefore =
        (balanceResult.rowCount ?? 0) > 0 ? Number(balanceResult.rows[0].quantity) : 0;

      const quantityAfter = quantityBefore - item.quantity;

      if ((balanceResult.rowCount ?? 0) === 0) {
        await client.query(
          `
          INSERT INTO stock_balances (
            company_id,
            branch_id,
            stock_location_id,
            variant_id,
            quantity
          )
          VALUES ($1, $2, $3, $4, $5);
          `,
          [companyId, branchId, stockLocationId, item.variantId, quantityAfter]
        );
      } else {
        await client.query(
          `
          UPDATE stock_balances
          SET quantity = $1,
              updated_at = NOW()
          WHERE company_id = $2
            AND stock_location_id = $3
            AND variant_id = $4;
          `,
          [quantityAfter, companyId, stockLocationId, item.variantId]
        );
      }

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
          companyId,
          branchId,
          stockLocationId,
          item.variantId,
          -Math.abs(item.quantity),
          quantityBefore,
          quantityAfter,
          sale.id,
          `Sale ${sale.sale_number}`,
          cashierId || null,
        ]
      );
    }

    const createdPayments = [];

    for (const payment of payments) {
      const method = payment.method;
      const amount = Number(payment.amount);

      if (!method || typeof method !== "string") {
        throw new Error("Payment method is required");
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Payment amount must be greater than zero");
      }

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
        [companyId, sale.id, method, amount, payment.reference || null]
      );

      createdPayments.push(paymentResult.rows[0]);
    }

    await client.query("COMMIT");

    res.status(201).json({
      data: {
        sale,
        items: createdItems,
        payments: createdPayments,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});