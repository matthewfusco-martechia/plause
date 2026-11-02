# Staging test conversation recovery

Updated 2026-11-02. **The user approved the exact recovery; it was executed once and independently verified.** The conditional update exited successfully and changed exactly one conversation to bot mode, incrementing its ownership version. No roles, messages or audit history were deleted.

An automated browser interaction accidentally requested human support in the sole staging web conversation. Its fictional writing prompt was received while replies were paused. Before recovery, independent D1 checks confirmed zero model attempts, usage, debit or held charges, one user message, one system notice, no staff roles or claims, and no pending inbox, outbound work or leases.

The executed recovery changed only that pinned conversation from customer-requested human mode to bot mode. It cleared the customer handoff reason, incremented the ownership version to fence stale work, cleared the already empty lease and updated the activity timestamp. The conditional update required the exact saved conversation/version and matching preflight conditions. It refuses a second execution and preserves an outcome receipt for reconciliation. Readback after recovery confirmed all model attempt, usage, debit and hold counts remained zero.

Messages, audit history, cancelled work, credentials, roles, feature flags and budgets were retained. The recovery did not replay the received prompt, grant staff permissions, change the server's staff-only resume rule, deploy code or contact Apple/MSP services. After successful readback, all three previously approved serial fictional cloud AI tests completed separately and passed with visible delivered replies, 1,423 microUSD estimated app debit and no held costs. See [activation results](staging-activation-review.md). This did not replay the pre-recovery prompt.

Explicit recovery approval was obtained because the approved activation sequence excluded staff roles and the normal staging resume endpoint requires a staff operator (`apps/api/src/index.ts`, `operator_resume_required`). The recovery used the owner's narrowly approved D1 maintenance access without assigning that role.

The misleading web control has separately been fixed and deployed after explicit approval: self-resume is available only in a confirmed local preview. Staging/production explain that authorized staff must resume the agent. Syntax validation, seven focused UI checks and the then-current full Node suite (113/113) passed. Its separately approved deployment is now independently verified by metadata/version and normal HTTPS browser/DOM checks; at the UI-only readback the same three AI replies and 1,423 microUSD ledger were unchanged, with no new generation. See [UI deployment evidence](staging-ui-fix-deployment-review.md). This is not a new full Worker/check or HTTP-E2E run.

The protected recovery script and its pinned target/receipts are in git-ignored `.local/staging-preparation/`; actual identifiers are omitted here.


The later [password deployment](staging-access.md) has separate full-check/HTTP evidence and current 4-attempt/1,969-microUSD account totals. The fourth turn predates that wall and is unattributed; it is not another coordinated test or replay of the recovery prompt. Manual Chrome password-prompt acceptance remains pending.
