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

The current system does not yet store authoritative moving-average cost or historical sale cost snapshots.

## Decision

ERPSYS Online will use:

**Perpetual Weighted Average Cost per stock location and product variant.**

The authoritative current cost will be stored in:

```text
stock_balances.average_cost
```
