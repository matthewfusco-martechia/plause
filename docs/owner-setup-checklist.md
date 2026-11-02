# Plause owner setup checklist

Updated 2026-11-02. The code is prepared locally, but the new agent application has no live provider configuration or deployment. This checklist separates actions requiring the owner's identity, payment, consent or physical device from configuration the developer can perform.

Your Cloudflare account, active plause.si domain, funded OpenAI account and Plause Development Google project already exist. Keep using them. The selected messaging path is direct Linq; Apple Messages for Business registration is outside this implementation.

## First private iMessage conversation

1. **Complete Linq signup and review its service agreement.** Confirm that the offered service supports this iMessage AI-agent use, an assigned sending number, API access and signed inbound webhooks. Review the actual quote before accepting or paying. Once available, leave the assigned number and credentials in the provider dashboard or a private local configuration for secure import. Never paste keys in chat.
2. **Approve a concrete hosting plan and complete any signup/payment verification.** The developer will prepare a Node 24 host with PostgreSQL and persistent workflow storage. Cloudflare R2 supplies object storage; it does not replace those runtime requirements. A separate agent hostname will be proposed for review, preserving the existing staging Worker.
3. **Authorize scoped access to the existing Cloudflare account.** Sign in or complete verification if requested. The developer can prepare the separate private R2 bucket, scoped credentials, DNS and TLS; you do not need to write configuration or recreate the account.
4. **Set the live-test spending limit and authorize OpenAI use in this app.** Billing is already ready. Review whether to use a separate project/key or authorize the existing project. The developer can configure the chosen credential privately and set app limits; provider-side limits are separate from the app's accounting. The previous Worker's three-call authorization is not a new testing budget.
5. **Complete Kernel account/billing setup.** The current application requires a Kernel API key at startup, including for the first hosted chat. Leave the key in a private configuration for secure import. The developer can configure the browser API and prepare tests. Once browser sessions are ready, enter website passwords/MFA yourself and review consequential browser actions. Use fictional tasks before enabling writes.
6. **Provide the exact test iPhone number and complete phone verification yourself.** The developer will configure closed enrollment for that number. Once the line and private host are ready, send a first iMessage to the Linq number, open the new app's sign-in screen, request the code and enter it yourself. Never share the code in chat. The old Worker's Google login does not automatically create this phone identity.
7. **Run the real-device acceptance steps with the developer.** Send the agreed fictional prompts from your iPhone and confirm replies and attachments arrive. Review any requested action personally. We will coordinate duplicate/restart recovery, opt-out and one explicitly consented scheduled notification. Local mock tests do not replace this check.

## Connected agent features before a pilot

8. **Review Google's app details and personally grant Workspace access.** Use the existing Plause Development project. The developer can prepare the separate Web OAuth client and API configuration. Review/create the client when prompted, save its JSON locally for secure import, then sign in and approve the Gmail, Calendar, Contacts and Drive scopes at the app's permission review. The exact callback will be `https://<approved-agent-host>/api/connections/google/callback`; use the final approved hostname, not this placeholder. Local agent development uses port 3000.
9. **If public web research is wanted, complete Tavily account/billing setup.** Leave its API key in a private local configuration for import. Research remains off until authorized, and the current implementation asks for approval of each query.
10. **Decide the private pilot's notification and data rules.** Specify who may test, proactive-message consent, cadence/quiet hours, retention and the initial spending limit. The developer still needs to complete and test proactive-consent enforcement and erasure/recovery across all stores before a pilot. Approving this checklist alone does not enable a pilot.

## Developer-owned work

The developer can prepare infrastructure/configuration, protected secret storage, password protection, TLS, migrations, callback/webhook routing, budgets, remaining consent/privacy implementation, automated tests and a concrete deployment review. Provider terms, purchases, account verification, OAuth consent, passwords/MFA and physical iPhone testing require your involvement. Keys and one-time codes stay out of chat and Git.

See [implementation and acceptance limits](../agent-app/PLAUSE.md), [private hosting](../agent-app/ops/README.md), and [provider selection](messaging-provider-decision.md).
