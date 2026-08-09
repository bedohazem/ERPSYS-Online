import type { PoolClient } from 'pg'

type CostedInboundMovementInput = {
  companyId: string
  branchId: string | null

  stockLocationId: string
  variantId: string

  quantity: number
  inventoryUnitCost: number

  referenceType: string
  referenceId: string

  note: string | null
  createdBy: string
}

export type CostedInboundMovementResult = {
  quantityBefore: number
  quantityAfter: number

  averageCostBefore: number
  averageCostAfter: number

  inventoryValueBefore: number
  inventoryValueAfter: number

  inventoryUnitCost: number
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

function roundCost(value: number) {
  return Number(value.toFixed(4))
}

function roundInventoryValue(value: number) {
  return Number(value.toFixed(4))
}

// ======================================================
// حساب تكلفة الوحدة التي تدخل المخزون.
//
// السياسة الحالية:
// تكلفة الشراء الأساسية - الخصم الموزع على الوحدة.
//
// الضريبة لا تدخل في تكلفة المخزون حاليًا.
// هنرجع للنقطة دي مع Tax Engine وLanded Cost.
// ======================================================
export function calculatePurchaseInventoryUnitCost(input: {
  quantity: number
  unitCost: number
  discountAmount: number
}) {
  if (
    !Number.isFinite(input.quantity) ||
    input.quantity <= 0
  ) {
    throw new Error(
      'Purchase costing quantity is invalid',
    )
  }

  if (
    !Number.isFinite(input.unitCost) ||
    input.unitCost < 0
  ) {
    throw new Error(
      'Purchase costing unit cost is invalid',
    )
  }

  if (
    !Number.isFinite(input.discountAmount) ||
    input.discountAmount < 0
  ) {
    throw new Error(
      'Purchase costing discount is invalid',
    )
  }

  const inventoryValue =
    input.quantity * input.unitCost -
    input.discountAmount

  if (inventoryValue < 0) {
    throw new Error(
      'Purchase inventory value cannot be negative',
    )
  }

  return roundCost(
    inventoryValue /
      input.quantity,
  )
}

// ======================================================
// إضافة كمية داخلة للمخزون باستخدام
// Perpetual Weighted Average Cost.
//
// الـCaller لازم يكون بدأ Transaction بالفعل.
//
// الدالة:
// 1. تضمن وجود stock_balance.
// 2. تقفل الرصيد FOR UPDATE.
// 3. تحسب متوسط التكلفة.
// 4. تحدث الكمية والتكلفة.
// 5. تنشئ stock_movement كاملة بالتكلفة.
// ======================================================
export async function applyWeightedAveragePurchaseInbound(
  client: PoolClient,
  input: CostedInboundMovementInput,
): Promise<CostedInboundMovementResult> {
  const quantity =
    roundQuantity(input.quantity)

  const inventoryUnitCost =
    roundCost(
      input.inventoryUnitCost,
    )

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      'Inbound quantity is invalid',
    )
  }

  if (
    !Number.isFinite(inventoryUnitCost) ||
    inventoryUnitCost < 0
  ) {
    throw new Error(
      'Inbound inventory cost is invalid',
    )
  }

  // إنشاء الرصيد فقط لو الصنف لم يدخل
  // مكان التخزين ده قبل كده.
  await client.query(
    `
      INSERT INTO stock_balances (
        company_id,
        branch_id,
        stock_location_id,
        variant_id,
        quantity,
        average_cost
      )
      VALUES (
        $1, $2, $3, $4, 0, 0
      )

      ON CONFLICT (
        company_id,
        stock_location_id,
        variant_id
      )
      DO NOTHING;
    `,
    [
      input.companyId,
      input.branchId,
      input.stockLocationId,
      input.variantId,
    ],
  )

  // لازم نقفل نفس رصيد المخزون قبل
  // قراءة الكمية والتكلفة لمنع Race Conditions.
  const balanceResult =
    await client.query(
      `
        SELECT
          quantity,
          average_cost

        FROM stock_balances

        WHERE company_id = $1
          AND stock_location_id = $2
          AND variant_id = $3

        FOR UPDATE;
      `,
      [
        input.companyId,
        input.stockLocationId,
        input.variantId,
      ],
    )

  if (
    (balanceResult.rowCount ?? 0) === 0
  ) {
    throw new Error(
      'Stock balance could not be locked',
    )
  }

  const quantityBefore =
    roundQuantity(
      Number(
        balanceResult.rows[0]
          .quantity,
      ),
    )

  const averageCostBefore =
    roundCost(
      Number(
        balanceResult.rows[0]
          .average_cost,
      ),
    )

  if (
    !Number.isFinite(quantityBefore) ||
    quantityBefore < 0
  ) {
    throw new Error(
      'Existing stock quantity is invalid',
    )
  }

  if (
    !Number.isFinite(
      averageCostBefore,
    ) ||
    averageCostBefore < 0
  ) {
    throw new Error(
      'Existing average cost is invalid',
    )
  }

  const inventoryValueBefore =
    roundInventoryValue(
      quantityBefore *
        averageCostBefore,
    )

  const receivedInventoryValue =
    roundInventoryValue(
      quantity *
        inventoryUnitCost,
    )

  const quantityAfter =
    roundQuantity(
      quantityBefore +
        quantity,
    )

  const averageCostAfter =
    quantityAfter > 0
      ? roundCost(
          (
            inventoryValueBefore +
            receivedInventoryValue
          ) /
            quantityAfter,
        )
      : inventoryUnitCost

  const inventoryValueAfter =
    roundInventoryValue(
      quantityAfter *
        averageCostAfter,
    )

  // Migration 038 تمنع تعديل average_cost
  // بشكل مباشر. بنفتح السماح داخل
  // الـTransaction الحالية فقط.
  await client.query(
    `
      SELECT set_config(
        'erpsys.allow_cost_update',
        'true',
        true
      );
    `,
  )

  await client.query(
    `
      UPDATE stock_balances

      SET
        quantity = $1,
        average_cost = $2,
        branch_id = $3,
        updated_at = NOW()

      WHERE company_id = $4
        AND stock_location_id = $5
        AND variant_id = $6;
    `,
    [
      quantityAfter,
      averageCostAfter,
      input.branchId,

      input.companyId,
      input.stockLocationId,
      input.variantId,
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

        unit_cost,
        average_cost_before,
        average_cost_after,

        inventory_value_before,
        inventory_value_after,

        reference_type,
        reference_id,

        note,
        created_by
      )
      VALUES (
        $1, $2,
        $3, $4,

        'purchase',

        $5, $6, $7,

        $8, $9, $10,

        $11, $12,

        $13, $14,

        $15, $16
      );
    `,
    [
      input.companyId,
      input.branchId,

      input.stockLocationId,
      input.variantId,

      quantity,
      quantityBefore,
      quantityAfter,

      inventoryUnitCost,
      averageCostBefore,
      averageCostAfter,

      inventoryValueBefore,
      inventoryValueAfter,

      input.referenceType,
      input.referenceId,

      input.note,
      input.createdBy,
    ],
  )

  return {
    quantityBefore,
    quantityAfter,

    averageCostBefore,
    averageCostAfter,

    inventoryValueBefore,
    inventoryValueAfter,

    inventoryUnitCost,
  }
}