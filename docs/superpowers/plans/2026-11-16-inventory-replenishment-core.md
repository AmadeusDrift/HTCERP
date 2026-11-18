# Inventory Replenishment Core Implementation Plan

> Execute the tasks in this chat against the confirmed specification. No production deployment or real inventory submission is included.

**Goal:** Persist supplement-to-five decisions and verify an offline/reconnected simulated executor without duplicate replenishment.

**Architecture:** A pure rule evaluator produces desired additions from source observations. D1 stores immutable scans, latest demands, exclusive attempts and idempotent results. Execution requires a fresh preflight; confirmed failures retry per SKU, and uncertain submissions remain locked.

**Tech Stack:** Existing TypeScript, Zod, D1 SQL and Vitest; Node SQLite exercises the real SQL in an isolated database.

- [x] Add behavioral tests for stock thresholds, zero-stock eligibility, seven-day initial scope and bans.
- [x] Implement `workbench/packages/inventory-sync/rules.ts` and run those tests.
- [x] Add real SQLite tests for offline consolidation, claims, preflight, ambiguous submissions, retries and restart persistence.
- [x] Implement an additive migration and `workbench/packages/inventory-sync/queue.ts`; keep all live routes and schedules untouched until source/device adapters are ready.
- [x] Run the targeted tests and TypeScript check; verify the confirmed business requirements against results.
- [x] Record the exact scope delivered and remaining live-integration work in the specification.

Tests are the executable implementation specification. No existing credentials, production records or unfinished workspace edits are changed.

Completed 2026-11-16: 24 new tests, full suite 266 tests in 34 files passed, TypeScript passed, focused Biome error-level checks passed. A focused reviewer found stale file/preflight binding and lost historical eligibility; both were reproduced with failing tests, corrected, and reviewed again. `receive-file.ts` additionally creates canonical fresh CSV bytes with an exact row map and SHA-256 hash; a test generates precisely 818 data rows without any prior workbook tail.
