# ERPSYS Online — Integrated Baseline UAT

## Purpose

This document is the execution checklist for validating the current ERP/POS baseline before adding new large business features.

The current UAT stage corresponds to backlog items:

- `T-001` Integrated current-baseline UAT.
- `T-002` Record and classify findings.
- `T-003` Fix blockers and critical regressions.
- `T-004` Freeze internal baseline.

## Reference

- Branch: `main`
- Documentation baseline commit: update after this document is merged.
- Product scope: Fashion Retail ERP/POS V1
- Test environment: local or staging database
- Production data must not be used.

## Result Values

Use one of:

- `PASS`
- `FAIL`
- `BLOCKED`
- `NOT TESTED`

## Severity Values

- `BLOCKER`: Data corruption, financial corruption, tenant leakage, or system cannot operate.
- `CRITICAL`: Major workflow fails with no safe workaround.
- `NORMAL`: Workflow works partially or has a safe workaround.
- `UI`: Display, wording, usability, or layout issue.

## Finding Format

For every failed scenario record:

```text
Finding ID:
Scenario ID:
Severity:
Environment:
User:
Company:
Branch:
Steps:
Expected:
Actual:
Database impact:
Screenshots or logs:
Related commit:
Resolution commit:
Retest result:
```

Test Preparation
Before starting:

Pull latest main.

Run all migrations.

Run npm run check.

Start API.

Start Web Admin.

Start Desktop POS.

Create or verify test company.

Create at least two branches.

Create company-level admin.

Create branch-level manager.

Create cashier user.

Create supplier.

Create customer.

Create products and variants.

Create sizes and colors.

Create stock locations.

Register a POS device.

Record starting database backup.

UAT-01 Authentication and Isolation

| ID       | Scenario                                                      | Result     | Notes |
| -------- | ------------------------------------------------------------- | ---------- | ----- |
| AUTH-001 | Valid admin login                                             | NOT TESTED |       |
| AUTH-002 | Invalid password rejected                                     | NOT TESTED |       |
| AUTH-003 | Disabled user rejected                                        | NOT TESTED |       |
| AUTH-004 | Branch user cannot access another branch's restricted records | NOT TESTED |       |
| AUTH-005 | User cannot access another company's records                  | NOT TESTED |       |
| AUTH-006 | Missing permission returns 403                                | NOT TESTED |       |
| AUTH-007 | Session company overrides frontend-supplied company ID        | NOT TESTED |       |
| AUTH-008 | Session branch overrides frontend-supplied branch ID          | NOT TESTED |       |
| AUTH-009 | Audit records identify the authenticated user                 | NOT TESTED |       |
| AUTH-010 | Revoked POS device cannot authenticate                        | NOT TESTED |       |

UAT-02 Catalog and Fashion

| ID      | Scenario                                   | Result     | Notes |
| ------- | ------------------------------------------ | ---------- | ----- |
| CAT-001 | Product appears with correct variants      | NOT TESTED |       |
| CAT-002 | Size/color combinations are correct        | NOT TESTED |       |
| CAT-003 | SKU is unique inside company               | NOT TESTED |       |
| CAT-004 | Primary barcode resolves correct variant   | NOT TESTED |       |
| CAT-005 | Alternate barcode resolves correct variant | NOT TESTED |       |
| CAT-006 | Deactivated variant cannot be sold         | NOT TESTED |       |
| CAT-007 | Price edit is audited                      | NOT TESTED |       |
| CAT-008 | Price history is visible                   | NOT TESTED |       |
| CAT-009 | Price restoration works                    | NOT TESTED |       |
| CAT-010 | POS catalog refresh receives updated price | NOT TESTED |       |

UAT-03 Inventory Opening and Movements

| ID      | Scenario                                          | Result     | Notes |
| ------- | ------------------------------------------------- | ---------- | ----- |
| INV-001 | Opening balance creates correct stock balance     | NOT TESTED |       |
| INV-002 | Opening balance creates stock movement            | NOT TESTED |       |
| INV-003 | Negative opening quantity is rejected             | NOT TESTED |       |
| INV-004 | Different locations maintain independent balances | NOT TESTED |       |
| INV-005 | Branch user sees allowed locations only           | NOT TESTED |       |
| INV-006 | Movement reference links to source document       | NOT TESTED |       |
| INV-007 | Repeated request does not duplicate balance       | NOT TESTED |       |

UAT-04 Transfers

| ID      | Scenario                                        | Result     | Notes |
| ------- | ----------------------------------------------- | ---------- | ----- |
| TRF-001 | Create transfer request                         | NOT TESTED |       |
| TRF-002 | Approve requested quantities                    | NOT TESTED |       |
| TRF-003 | Approve smaller quantity                        | NOT TESTED |       |
| TRF-004 | Ship approved quantity only                     | NOT TESTED |       |
| TRF-005 | Source stock is reduced                         | NOT TESTED |       |
| TRF-006 | Destination stock is unchanged before receipt   | NOT TESTED |       |
| TRF-007 | Receive full quantity                           | NOT TESTED |       |
| TRF-008 | Receive partial quantity and record discrepancy | NOT TESTED |       |
| TRF-009 | Receiving more than shipped is rejected         | NOT TESTED |       |
| TRF-010 | Cancel eligible transfer                        | NOT TESTED |       |
| TRF-011 | Cannot cancel completed transfer                | NOT TESTED |       |
| TRF-012 | Duplicate shipping or receiving is safe         | NOT TESTED |       |
| TRF-013 | Transfer movements are correct                  | NOT TESTED |       |
| TRF-014 | Cross-company location is rejected              | NOT TESTED |       |

UAT-05 Stock Count

| ID      | Scenario                                     | Result     | Notes |
| ------- | -------------------------------------------- | ---------- | ----- |
| CNT-001 | Open stock-count session                     | NOT TESTED |       |
| CNT-002 | Snapshot matches current stock               | NOT TESTED |       |
| CNT-003 | Enter physical quantities                    | NOT TESTED |       |
| CNT-004 | Variances calculate correctly                | NOT TESTED |       |
| CNT-005 | Approve positive variance                    | NOT TESTED |       |
| CNT-006 | Approve negative variance                    | NOT TESTED |       |
| CNT-007 | Approval updates balances                    | NOT TESTED |       |
| CNT-008 | Approval creates stock movements             | NOT TESTED |       |
| CNT-009 | Changed stock after snapshot blocks approval | NOT TESTED |       |
| CNT-010 | Cancellation works before approval           | NOT TESTED |       |
| CNT-011 | Approved count cannot be edited              | NOT TESTED |       |
| CNT-012 | Duplicate approval is safe                   | NOT TESTED |       |

UAT-06 Damaged and Inspection Stock

| ID      | Scenario                                   | Result     | Notes |
| ------- | ------------------------------------------ | ---------- | ----- |
| EXC-001 | Move quantity to damaged location          | NOT TESTED |       |
| EXC-002 | Move quantity to inspection location       | NOT TESTED |       |
| EXC-003 | Release inspected stock correctly          | NOT TESTED |       |
| EXC-004 | Reject inspected stock to damaged location | NOT TESTED |       |
| EXC-005 | Insufficient stock is rejected             | NOT TESTED |       |
| EXC-006 | Movements and balances match               | NOT TESTED |       |
| EXC-007 | Branch isolation is enforced               | NOT TESTED |       |
| EXC-008 | Audit records are created                  | NOT TESTED |       |

UAT-07 Procurement

| ID      | Scenario                                           | Result     | Notes |
| ------- | -------------------------------------------------- | ---------- | ----- |
| PUR-001 | Create purchase order                              | NOT TESTED |       |
| PUR-002 | Receive full purchase order                        | NOT TESTED |       |
| PUR-003 | Receive partial purchase order                     | NOT TESTED |       |
| PUR-004 | Repeated receipt is idempotent                     | NOT TESTED |       |
| PUR-005 | Receipt increases correct location stock           | NOT TESTED |       |
| PUR-006 | Purchase movements are correct                     | NOT TESTED |       |
| PUR-007 | Create supplier invoice from receipt               | NOT TESTED |       |
| PUR-008 | Duplicate invoice for same receipt is rejected     | NOT TESTED |       |
| PUR-009 | Record partial supplier payment                    | NOT TESTED |       |
| PUR-010 | Record full supplier payment                       | NOT TESTED |       |
| PUR-011 | Payment above balance is rejected                  | NOT TESTED |       |
| PUR-012 | Payment retry is idempotent                        | NOT TESTED |       |
| PUR-013 | Supplier invoice status changes correctly          | NOT TESTED |       |
| PUR-014 | Branch user cannot access another branch's invoice | NOT TESTED |       |

UAT-08 Supplier Returns

| ID      | Scenario                                        | Result     | Notes |
| ------- | ----------------------------------------------- | ---------- | ----- |
| SRT-001 | Load returnable receipt items                   | NOT TESTED |       |
| SRT-002 | Create partial supplier return                  | NOT TESTED |       |
| SRT-003 | Return reduces stock                            | NOT TESTED |       |
| SRT-004 | Purchase-return movement is created             | NOT TESTED |       |
| SRT-005 | Credit note is created                          | NOT TESTED |       |
| SRT-006 | Supplier invoice balance is updated             | NOT TESTED |       |
| SRT-007 | Return above received quantity is rejected      | NOT TESTED |       |
| SRT-008 | Return above current stock is rejected          | NOT TESTED |       |
| SRT-009 | Duplicate return retry is safe                  | NOT TESTED |       |
| SRT-010 | Supplier credit balance is calculated correctly | NOT TESTED |       |

UAT-09 Online Sales

| ID      | Scenario                               | Result     | Notes |
| ------- | -------------------------------------- | ---------- | ----- |
| SAL-001 | Create paid online sale                | NOT TESTED |       |
| SAL-002 | Sale deducts correct stock             | NOT TESTED |       |
| SAL-003 | Sale movements are created             | NOT TESTED |       |
| SAL-004 | Payments are recorded                  | NOT TESTED |       |
| SAL-005 | Duplicate submission returns same sale | NOT TESTED |       |
| SAL-006 | Insufficient stock is rejected         | NOT TESTED |       |
| SAL-007 | Wrong-company product is rejected      | NOT TESTED |       |
| SAL-008 | Wrong-branch location is rejected      | NOT TESTED |       |
| SAL-009 | Sale details display correct totals    | NOT TESTED |       |
| SAL-010 | Cash change is calculated correctly    | NOT TESTED |       |

UAT-10 Credit Sales and Collections

| ID      | Scenario                                      | Result     | Notes |
| ------- | --------------------------------------------- | ---------- | ----- |
| REC-001 | Enable customer credit policy                 | NOT TESTED |       |
| REC-002 | Credit sale without customer is rejected      | NOT TESTED |       |
| REC-003 | Credit sale for disabled customer is rejected | NOT TESTED |       |
| REC-004 | Full credit sale succeeds inside limit        | NOT TESTED |       |
| REC-005 | Partially paid sale succeeds                  | NOT TESTED |       |
| REC-006 | Credit limit is enforced exactly              | NOT TESTED |       |
| REC-007 | Outstanding total is correct                  | NOT TESTED |       |
| REC-008 | Due date uses payment terms                   | NOT TESTED |       |
| REC-009 | Partial collection updates sale               | NOT TESTED |       |
| REC-010 | Full collection closes balance                | NOT TESTED |       |
| REC-011 | Over-collection is rejected                   | NOT TESTED |       |
| REC-012 | Collection retry returns same result          | NOT TESTED |       |
| REC-013 | Customer statement is correct                 | NOT TESTED |       |
| REC-014 | Voided-sale collection is shown reversed      | NOT TESTED |       |
| REC-015 | Reversed collection is excluded from totals   | NOT TESTED |       |

UAT-11 Sale Void, Returns, and Exchanges

| ID      | Scenario                                          | Result     | Notes |
| ------- | ------------------------------------------------- | ---------- | ----- |
| REV-001 | Void fully paid sale                              | NOT TESTED |       |
| REV-002 | Void partially paid sale                          | NOT TESTED |       |
| REV-003 | Void unpaid credit sale                           | NOT TESTED |       |
| REV-004 | Void restores stock                               | NOT TESTED |       |
| REV-005 | Void reverses collected amount only               | NOT TESTED |       |
| REV-006 | Void clears outstanding balance                   | NOT TESTED |       |
| REV-007 | Create partial customer return                    | NOT TESTED |       |
| REV-008 | Return cannot exceed returnable quantity          | NOT TESTED |       |
| REV-009 | Return restores stock                             | NOT TESTED |       |
| REV-010 | Return refund records are correct                 | NOT TESTED |       |
| REV-011 | Unpaid sale cannot use normal return flow         | NOT TESTED |       |
| REV-012 | Create exchange                                   | NOT TESTED |       |
| REV-013 | Exchange return and replacement stock are correct | NOT TESTED |       |
| REV-014 | Exchange price difference is correct              | NOT TESTED |       |
| REV-015 | Duplicate operations are safe                     | NOT TESTED |       |

UAT-12 Desktop POS Online

| ID         | Scenario                            | Result     | Notes |
| ---------- | ----------------------------------- | ---------- | ----- |
| POS-ON-001 | Register device                     | NOT TESTED |       |
| POS-ON-002 | Login cashier                       | NOT TESTED |       |
| POS-ON-003 | Open shift                          | NOT TESTED |       |
| POS-ON-004 | Refresh catalog                     | NOT TESTED |       |
| POS-ON-005 | Scan barcode                        | NOT TESTED |       |
| POS-ON-006 | Search SKU and name                 | NOT TESTED |       |
| POS-ON-007 | Create online sale                  | NOT TESTED |       |
| POS-ON-008 | Sale appears in Web Admin           | NOT TESTED |       |
| POS-ON-009 | Server stock is updated             | NOT TESTED |       |
| POS-ON-010 | Close shift with correct settlement | NOT TESTED |       |

UAT-13 Desktop POS Offline and Sync

| ID          | Scenario                                             | Result     | Notes |
| ----------- | ---------------------------------------------------- | ---------- | ----- |
| POS-OFF-001 | Start with valid offline grant                       | NOT TESTED |       |
| POS-OFF-002 | Create pending sale without network                  | NOT TESTED |       |
| POS-OFF-003 | Local stock is not deducted                          | NOT TESTED |       |
| POS-OFF-004 | Restart application and restore pending sale         | NOT TESTED |       |
| POS-OFF-005 | Manual sync succeeds                                 | NOT TESTED |       |
| POS-OFF-006 | Automatic sync succeeds                              | NOT TESTED |       |
| POS-OFF-007 | Timeout after server success does not duplicate sale | NOT TESTED |       |
| POS-OFF-008 | Duplicate retry returns existing sale                | NOT TESTED |       |
| POS-OFF-009 | Price conflict enters expected state                 | NOT TESTED |       |
| POS-OFF-010 | Stock conflict enters expected state                 | NOT TESTED |       |
| POS-OFF-011 | Conflict is visible in Web Admin                     | NOT TESTED |       |
| POS-OFF-012 | Conflict resolution is audited                       | NOT TESTED |       |
| POS-OFF-013 | Shift cannot close with unresolved pending sale      | NOT TESTED |       |
| POS-OFF-014 | Revoked device is rejected                           | NOT TESTED |       |
| POS-OFF-015 | Expired offline grant is rejected                    | NOT TESTED |       |

UAT-14 Reports

| ID      | Scenario                                                 | Result     | Notes |
| ------- | -------------------------------------------------------- | ---------- | ----- |
| RPT-001 | Dashboard totals match source data                       | NOT TESTED |       |
| RPT-002 | Sales performance excludes voided transactions correctly | NOT TESTED |       |
| RPT-003 | Product performance handles returns correctly            | NOT TESTED |       |
| RPT-004 | Reorder report matches current stock                     | NOT TESTED |       |
| RPT-005 | Customer receivables totals match sales                  | NOT TESTED |       |
| RPT-006 | Reversed collections are excluded                        | NOT TESTED |       |
| RPT-007 | Supplier balances match invoices and credits             | NOT TESTED |       |
| RPT-008 | Branch filters are enforced                              | NOT TESTED |       |
| RPT-009 | Company isolation is enforced                            | NOT TESTED |       |

UAT-15 Database and Recovery

| ID     | Scenario                                              | Result     | Notes |
| ------ | ----------------------------------------------------- | ---------- | ----- |
| DB-001 | Clean database migration succeeds                     | NOT TESTED |       |
| DB-002 | Re-running migration command is safe                  | NOT TESTED |       |
| DB-003 | Failed business transaction rolls back                | NOT TESTED |       |
| DB-004 | Unique idempotency constraints work                   | NOT TESTED |       |
| DB-005 | Tenant-aware foreign keys reject mismatched relations | NOT TESTED |       |
| DB-006 | Backup completes                                      | NOT TESTED |       |
| DB-007 | Backup restore succeeds in separate database          | NOT TESTED |       |

Exit Criteria
The baseline may be frozen only when:

No open BLOCKER.

No open tenant-isolation issue.

No open stock-corruption issue.

No open financial-corruption issue.

All critical workflows have passed.

Failed scenarios have finding IDs.

Fixes have commit SHAs.

Fixed scenarios have been retested.

Clean migration test passes.

npm run check passes.

docs/backlog.md reflects the UAT state.

An internal baseline commit or tag is recorded.

## Final UAT Summary

```text
Date:
Environment:
Tester:
Reference commit:

Total scenarios:
Passed:
Failed:
Blocked:
Not tested:

Blockers:
Critical findings:
Normal findings:
UI findings:

Baseline accepted:
Accepted by:
Notes:
```
