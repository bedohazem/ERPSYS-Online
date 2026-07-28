# Sales Performance Analytics

## Feature Status

- **Implementation:** Completed
- **Final integrated testing:** Pending
- **Production smoke test:** Pending

Main implementation commits:

```text
99665715 — feat(reports): add sales performance analytics API
d74ef481 — feat(web-admin): add sales performance report
3bf280e6 — fix(web-admin): keep sales report filters consistent
```

---

## Purpose

The Sales Performance Analytics feature provides management reports for sales, returns and exchanges across a selected period.

The report supports analysis by:

- Date range.
- Branch.
- Cashier.
- Individual day.
- Entire company.

The report is available through the Web Admin and is protected by authenticated tenant and permission controls.

---

## Main Files

### Backend

```text
services/api/src/modules/reports/reports.routes.ts
services/api/src/modules/auth/auth.middleware.ts
```

### Web Admin

```text
apps/web-admin/src/pages/SalesPerformancePage.tsx
apps/web-admin/src/App.tsx
apps/web-admin/src/styles.css
```

---

## Required Permission

```text
reports.view
```

Administrators also receive access through the reserved admin-role bypass.

---

## Report API

```http
GET /api/reports/sales-performance
```

### Required Query Parameters

```text
dateFrom
dateTo
```

Dates use:

```text
YYYY-MM-DD
```

Example:

```http
GET /api/reports/sales-performance?dateFrom=2026-07-01&dateTo=2026-07-31
```

### Optional Query Parameters

```text
branchId
cashierId
```

Branch example:

```http
GET /api/reports/sales-performance?dateFrom=2026-07-01&dateTo=2026-07-31&branchId=BRANCH_UUID
```

Cashier example:

```http
GET /api/reports/sales-performance?dateFrom=2026-07-01&dateTo=2026-07-31&cashierId=USER_UUID
```

Combined example:

```http
GET /api/reports/sales-performance?dateFrom=2026-07-01&dateTo=2026-07-31&branchId=BRANCH_UUID&cashierId=USER_UUID
```

---

## Date Validation

The Backend validates:

- Start date exists.
- End date exists.
- Both dates use valid `YYYY-MM-DD` values.
- Start date is not after the end date.
- The requested period does not exceed 366 days.

---

## Tenant and Branch Security

Company identity always comes from the authenticated session.

A user attached to a branch:

- Is restricted to that branch.
- Cannot override the branch through query parameters.
- Cannot view another branch’s report.

A company-level user:

- May view all company branches.
- May select one branch inside report routes.
- Cannot request a branch belonging to another company.

Requested cashier IDs are also validated against the authenticated company.

---

## Included Sale Statuses

Active sale totals include:

```text
completed
pending_review
refunded
```

Voided sales:

```text
voided
```

are counted separately and do not enter gross sales.

Sales requiring review are included in the report and displayed in a separate counter.

---

## Included Return Statuses

Return totals include:

```text
completed
pending_review
```

Voided and draft returns are excluded.

The report includes:

- Return document count.
- Customer refund value.
- Returned item quantity.

---

## Included Exchange Statuses

Exchange totals include:

```text
completed
pending_review
```

Voided and draft exchanges are excluded.

The report includes:

- Exchange document count.
- Returned merchandise value.
- Issued merchandise value.
- Returned item quantity.
- Issued item quantity.
- Net exchange difference.

---

## Main Metrics

### Gross Sales

```text
Gross sales =
Total value of active sale invoices
```

Voided invoices are excluded.

### Sold Quantity

```text
Sold quantity =
Sum of quantities in active sale invoice items
```

### Return Refunds

```text
Return refunds =
Total customer refund values from active returns
```

### Exchange Net

```text
Exchange net =
Issued merchandise value
- Returned merchandise value
```

Positive exchange net means the issued merchandise value is greater.

Negative exchange net means the returned merchandise value is greater.

### Net Revenue

```text
Net revenue =
Gross sales
- Return refunds
+ Exchange net
```

This is a revenue report, not a profit report.

Product cost and gross-profit calculations are not included in this feature.

### Average Sale Value

```text
Average sale value =
Gross sales
÷ Active sale invoice count
```

When no active invoices exist, the value is zero.

---

## Report Response

The response contains:

```text
filters
definitions
summary
byDay
byBranch
byCashier
```

### Filters

Returns the effective:

- Company ID.
- Branch ID.
- Cashier ID.
- Start date.
- End date.
- Number of days.

### Definitions

Returns:

- Active sale statuses.
- Active return statuses.
- Active exchange statuses.
- Net revenue formula.

### Summary

Returns totals for the entire selected report.

### By Day

Returns activity grouped by calendar day.

Days without financial activity are not returned.

### By Branch

Returns activity grouped by branch.

### By Cashier

Returns activity grouped by the user who created or performed the relevant operation.

Deleted or unavailable users may appear as an unknown user while preserving historical totals.

---

## Web Admin Screen

The navigation page is:

```text
تقارير المبيعات
```

The screen provides:

- Start-date selection.
- End-date selection.
- Branch filter.
- Cashier filter.
- Report refresh.
- Filter reset.
- Period length.
- Summary metric cards.
- Daily sales chart.
- Daily details table.
- Branch comparison table.
- Cashier comparison table.
- Revenue-formula explanation.

---

## Summary Cards

The screen displays:

- Gross sales.
- Net revenue.
- Sale invoice count.
- Average sale value.
- Sold quantity.
- Return value and count.
- Exchange net and count.
- Pending-review and voided-sale counts.

Positive and negative financial values use distinct visual indicators.

---

## Daily Chart

The daily chart compares gross sales for every active day.

Bar width is calculated relative to the highest gross-sales day inside the current filtered result.

Each day also displays:

- Gross sales.
- Net revenue.

The chart is implemented with local HTML and CSS and does not require an external chart library.

---

## Filter Behaviour

The report does not update from input changes until the user presses:

```text
تحديث التقرير
```

While loading a new report:

- Previous results are cleared.
- Old numbers are not displayed beneath new filters.
- Loading feedback is displayed.

When branch and cashier filters are cleared:

- Both selections reset.
- The unfiltered report reloads automatically.
- Branch options reload.
- Cashier options reload.
- Stale filtered results are removed.

---

## Current Limitations

- Branch options contain branches with activity in the selected period.
- Cashier options contain users with activity in the selected period.
- Days without activity are not added as zero-value rows.
- The report measures revenue, not accounting profit.
- Product cost, margin and tax analytics are separate future features.
- Export to Excel or PDF is not implemented yet.
- Scheduled report delivery is not implemented yet.

---

## Security Controls

- Authenticated API access.
- `reports.view` permission.
- Admin-role permission bypass.
- Authenticated company identity.
- Branch restriction for branch users.
- Company-level branch selection for reports only.
- Branch UUID validation.
- Cashier UUID validation.
- Cross-company branch rejection.
- Cross-company cashier rejection.
- Maximum report period of 366 days.
- PostgreSQL aggregation.
- No frontend-supplied company trust.
- No direct database access from Web Admin.

---

## Implementation Checklist

- [x] Date-range report API
- [x] Date validation
- [x] Maximum period validation
- [x] Company isolation
- [x] Branch isolation
- [x] Company-level branch filter
- [x] Cashier filter
- [x] Cross-company branch validation
- [x] Cross-company cashier validation
- [x] Gross-sales calculation
- [x] Sold-quantity calculation
- [x] Return-refund calculation
- [x] Returned-quantity calculation
- [x] Exchange-value calculation
- [x] Exchange-quantity calculation
- [x] Net-revenue calculation
- [x] Average-sale calculation
- [x] Voided-sale count
- [x] Pending-review count
- [x] Daily grouping
- [x] Branch grouping
- [x] Cashier grouping
- [x] Web Admin report page
- [x] Summary cards
- [x] Daily chart
- [x] Daily table
- [x] Branch table
- [x] Cashier table
- [x] Responsive report layout
- [x] Consistent filter reset
- [x] Stale-report protection
- [x] Feature documentation
- [ ] Final integrated acceptance test
- [ ] Production smoke test
- [ ] Excel export
- [ ] PDF export
- [ ] Profit and cost report

---

## Final Acceptance Scenarios

### Company Report

- Log in as a company-level manager.
- Select a valid date range.
- Load all branches.
- Confirm summary values equal branch totals.

### Branch Report

- Select one branch.
- Confirm all returned rows belong to that branch.
- Confirm another company’s branch ID is rejected.

### Branch User Isolation

- Log in as a branch-restricted user.
- Attempt to send another branch ID manually.
- Confirm the authenticated branch is enforced.

### Cashier Report

- Select one cashier.
- Confirm sales, returns and exchanges belong to that user.

### Combined Filter

- Select one branch and one cashier.
- Confirm only matching operations appear.

### Voided Sale

- Void a sale.
- Confirm the voided counter increases.
- Confirm gross sales exclude the voided invoice.

### Pending Review Sale

- Synchronize an offline sale requiring review.
- Confirm the pending-review counter increases.
- Confirm its value follows the documented active-status rule.

### Return

- Create a completed return.
- Confirm return count and refund value increase.
- Confirm net revenue decreases.

### Exchange

- Create an exchange with a positive difference.
- Confirm exchange net increases net revenue.

- Create an exchange with a negative difference.
- Confirm exchange net decreases net revenue.

### Filter Reset

- Apply branch and cashier filters.
- Clear the filters.
- Confirm the report automatically reloads for the full accessible scope.

### Stale Data Protection

- Load one period.
- Change the period and refresh.
- Confirm the previous period’s values disappear during loading.

### Empty Period

- Select a valid period without activity.
- Confirm the screen displays zero summary values and empty-state messages.

### Invalid Period

- Use an invalid date.
- Use a start date after the end date.
- Use a period exceeding 366 days.
- Confirm every request is rejected with a validation response.

---

## Completion Definition

Current feature state:

```text
IMPLEMENTATION COMPLETE
```

Remaining work:

- Final integrated acceptance testing.
- Production smoke testing.
- Export features.
- Profit and cost analytics.
