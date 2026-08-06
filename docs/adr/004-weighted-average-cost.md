# ADR-004: Perpetual Weighted Average Inventory Cost

## Status

Accepted

## Date

2026-08-06

## Context

ERPSYS Online requires a stable inventory-costing method for:

- Inventory valuation.
- Gross-profit calculation.
- Product and variant profitability.
- Branch and stock-location analysis.
- Historical sales reporting.
- Future purchasing and replenishment decisions.

The current inventory model stores quantities per:

- Company.
- Stock location.
- Product variant.

The system did not previously store authoritative moving-average cost or historical sale cost snapshots.

## Decision

ERPSYS Online will use:

**Perpetual Weighted Average Cost per stock location and product variant.**

The authoritative current cost is stored in:

```text
stock_balances.average_cost
```

Every cost-aware inventory movement may preserve:

```text
unit_cost
average_cost_before
average_cost_after
inventory_value_before
inventory_value_after
```

Every posted sale item will preserve:

```text
unit_cost_snapshot
cost_total_snapshot
gross_profit_snapshot
gross_margin_percent
```

## Purchase Receipt Calculation

For an approved inbound purchase:

```text
old inventory value =
old quantity × old average cost

received inventory value =
received quantity × inventory unit cost

new average cost =
(old inventory value + received inventory value)
÷
(old quantity + received quantity)
```

The Backend performs this calculation inside the same PostgreSQL transaction that updates stock.

## Outbound Movement Rule

Normal outbound movements do not recalculate the average cost.

Examples:

- Sale.
- Supplier return.
- Transfer shipment.
- Damage.
- Negative inventory adjustment.

They reduce quantity using the location’s current average cost.

## Transfer Rule

A transfer carries the source-location cost.

During shipment:

- The source quantity decreases.
- The source average cost remains unchanged.
- The shipped quantity carries the source average cost.

During receipt:

- The destination treats the transferred quantity as an inbound costed movement.
- The destination recalculates its weighted average using the transferred unit cost.

## Customer Return Rule

A customer return should restore inventory using the original sale-item cost snapshot.

It must not use the current average cost as the historical return cost.

The returned quantity is then treated as a costed inbound movement at the selected return location.

## Supplier Return Rule

A supplier return removes inventory using an authoritative cost determined by the approved supplier-return policy.

The workflow must preserve:

- Quantity removed.
- Cost removed.
- Inventory value before and after.
- Related purchase receipt and supplier credit note.

## Zero-Quantity Rule

When quantity reaches zero:

- Inventory value becomes zero.
- The last average cost may remain stored for operational continuity.
- A future inbound movement recalculates the weighted average normally.

Average cost must never become negative.

## Negative Stock Rule

V1 does not permit normal operations to produce negative stock.

Weighted-average calculations assume stock quantity remains non-negative.

Any future negative-stock policy requires a separate ADR.

## Sale Snapshot Rule

When a sale is posted, every sale item stores the current average cost from the selling stock location.

Historical profitability uses the stored snapshot.

It must never be recalculated using the product’s current cost.

## Cost Inputs

Inventory cost is separate from selling price.

The purchase workflow must calculate an explicit approved inventory unit cost.

The costing policy must define the treatment of:

- Item discounts.
- Recoverable taxes.
- Non-recoverable taxes.
- Freight.
- Customs.
- Landed costs.
- Other acquisition expenses.

Until the Tax and Landed Cost engines are implemented, the V1 purchase-receipt integration must use a documented temporary cost formula rather than allowing reports to infer cost silently.

## Existing Inventory Activation

Stock that existed before costing activation may initially have quantity with an average cost of zero.

This stock must not be silently assigned an invented cost.

A separate controlled initialization or cost-revaluation workflow must be used to establish opening costs.

Historical sales created before cost snapshots remain distinguishable from fully costed sales.

## Manual Editing

Direct manual editing of `stock_balances.average_cost` is forbidden.

Cost may change only through approved workflows:

- Purchase receipt.
- Transfer receipt.
- Customer return.
- Supplier return.
- Approved cost revaluation.
- Approved inventory adjustment carrying cost.

Any such change must be transactional, traceable, and reflected in stock movements.

## Concurrency

Cost calculations must lock the affected `stock_balances` row before reading quantity and average cost.

When multiple variants are involved, rows must be locked in a stable deterministic order.

This prevents concurrent receipts or movements from calculating from stale values.

## Rounding

- Quantities use up to three decimal places.
- Unit costs use four decimal places.
- Document monetary totals use two decimal places.
- Intermediate inventory-value calculations use sufficient precision before final rounding.

The Backend is authoritative for rounding.

## Rejected Alternatives

### FIFO

Rejected for V1 because it requires cost layers and substantially more complex return, transfer, reconciliation, and reporting logic.

### LIFO

Rejected because it is unsuitable for the intended operational and reporting scope.

### Standard Cost

Rejected as the primary method because actual purchasing costs vary and the system requires actual inventory valuation.

### Company-Wide Average

Rejected because inventory is stored and operated independently across branches and stock locations.

### Cost Layers with Weighted Average

Rejected for V1 because they add complexity without being required for the selected costing method.

## Consequences

### Benefits

- Fast current-cost lookup.
- Reliable inventory valuation.
- Historical sale profit remains stable.
- No FIFO-layer complexity.
- Suitable for Fashion Retail V1.
- Supports branch and location profitability.

### Trade-offs

- Transfer receiving must be cost-aware.
- Historical pre-costing stock needs controlled initialization.
- Landed-cost adjustments need a later revaluation workflow.
- Cost corrections require reversal or revaluation rather than direct editing.
- Every inventory workflow must preserve costing invariants.

## Implementation Plan

1. Add costing columns and constraints.
2. Integrate purchase receipts.
3. Integrate transfers.
4. Integrate supplier and customer returns.
5. Add sale cost and profit snapshots.
6. Add controlled opening-cost initialization.
7. Add inventory valuation and profitability reports.
8. Add concurrency and UAT coverage.
