<!-- codebase-guardian -->
## JSDoc Standards (Codebase Guardian)

Every exported function MUST have complete JSDoc with ALL of these tags:

- `@what` — Brief description of what the function does
- `@how` — Technical details of how it accomplishes the task
- `@why` — Business/architectural reason why this function exists
- `@param {type} name description` — For EACH parameter
- `@returns {type} description` — ALWAYS required, even for void
- `@sideeffects` — "None" if pure, or list of side effects
- `@systemlayer` — One of: UI Helper, Business Logic, Data Layer, API, Validation, Utility, etc.
- `@domain` — Business domain(s), comma-separated
- `@tags` — Minimum 3 comma-separated searchable keywords (5 preferred)

Interfaces, type aliases, and enums require at minimum:
- `@what` — Brief description (MANDATORY)
- `@domain` — Business domain (recommended)
- `@tags` — Minimum 2 searchable keywords (recommended)

Example:
```typescript
/**
 * @what Calculates the weighted average cost basis across all lots
 * @how Divides total invested capital by total shares, applying wash sale adjustments
 * @why Required for accurate P&L reporting and tax lot accounting
 *
 * @param {TaxLot[]} lots Array of tax lots to average
 * @param {boolean} includeWashSales Whether to include wash sale adjustments
 * @returns {number} Weighted average cost basis per share
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain portfolio, cost-basis, tax-lots
 * @tags cost-basis, weighted-average, wash-sale, tax-lots, portfolio-calculation
 */
```
<!-- /codebase-guardian -->
