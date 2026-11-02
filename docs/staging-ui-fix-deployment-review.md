# Staging resume-control fix deployment

Updated 2026-11-02. **The user approved this exact UI update; deployment and independent cloud/browser verification are complete.** The original staging activation and its three AI tests remain complete, with no new model call.

This follow-up published the tested web control correction to the existing `plause-staging` Worker at `https://staging.plause.si`:

- “Resume agent” is hidden and disabled unless the service explicitly reports a local preview and the conversation is paused.
- Staging and production explain that an authorized staff member must resume the agent.
- An unknown environment or stale control cannot issue a self-resume request. The server's existing staff-only rule remains unchanged.

Changed product files: `apps/api/public/index.html` and `apps/api/public/app.js`. Regression coverage is in `scripts/e2e.test.mjs`. Syntax validation, seven focused UI checks and the entire 113-test Node suite passed. The actual staging dry run passed; protected build scanning found no secret values. This is a targeted UI validation, not a new full Worker/HTTP-E2E acceptance claim.

The deployment used the exact closed-signup configuration already verified in staging, without a secret file. Independent cloud verification matched the new version and retained all five existing secret names/types, D1/private R2/queue/cron/hostname bindings, signup=false and both 30,000 microUSD monthly app-accounting budgets. Apple, Calendar and search remain off, with no operator bootstrap. No resource creation, schema migration, role grant, model call, Apple/MSP connection, plan change or purchase occurred.

The guarded execution exited 0 with zero input bytes, no prompts, no abort and no retry. Prior deployment receipts were retained. Independent metadata/version checks passed. A normal HTTPS IAB reload retained the signed-in account; selecting Conversation showed all three existing replies delivered, Hosted model active and Server connected. Live DOM checks confirmed `#return-button` hidden/disabled and `#handoff-resume-note` reading “An authorized staff member must resume the agent.” Private `ui-resume-browser-verification.json`, `cloud-verification-ui-resume.json` and screenshot `staging-ui-fix-deployed.png` retain evidence.

At the UI-only deployment readback, D1 counts were 1 active Google account, 2 valid Google sessions, 1 web binding, 3 successful Google sign-ins, 3 model attempts and no operator roles, invitation users or calendars. At that readback the model ledger showed 3 completed attempts, 5,586 input/47 output tokens, 1,423 microUSD estimated app debit and zero failed/purged/unknown/unresolved/held/delivery-unknown outcomes. No additional coordinated AI test is authorized.

The protected plan is `.local/staging-preparation/ui-resume-deployment-plan.json`, state `approved_deployed_independently_verified`; execution used `deploy-ui-resume-fix.py`. The verified snapshot for this UI-only deployment was `5bbde33780d3281ca5b2de36a90e28019f18d2a670463ff14d40a5092da808ac` using the same 69-file inventory. The original three AI tests used snapshot `26e700886370ffc89032ad2c8152ca47780521b78fbb91e2dadb1e0f877df74a`; no new full Worker/HTTP-E2E run or AI generation is claimed. Apple/MSP approval and live channel acceptance remain separate, uncompleted gates.


The later [password wall](staging-access.md) supersedes this runtime snapshot and adds a sixth secret. Its cloud/15-HTTP checks passed; manual Chrome Basic-prompt acceptance is pending. Current totals of 4 completed attempts/1,969 microUSD include a pre-wall, unattributed account turn whose contents were not read; no model call occurred after wall deployment at readback. This does not change the historical three-test/1,423-microUSD result above.
