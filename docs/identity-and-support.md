# Identity, channel linking and staff support

Cloud authentication uses Google OpenID Connect with `openid profile`. Calendar consent is separate. The identity key is the exact verified issuer/subject pair; email, phone numbers, display names and provider external IDs never merge accounts. RS256 signature/JWKS, issuer, audience, authorized party, nonce, expiry, state, browser proof and PKCE are verified. Authorization codes are consumed once. No identity refresh token or calendar scope is retained.

`POST /api/auth/google/start` accepts `{intent:"signin"}` or `{intent:"reauth"}` with same-origin protection. A newly completed code flow confirms current account possession; it does not claim the user entered a password or completed MFA. Fresh confirmation lasts five minutes for sensitive operations. Sign-in and calendar callbacks use separate short-lived Lax proof cookies while the ordinary session stays HttpOnly and SameSite=Strict. Cloud cookies are Secure. Public signup defaults off. In staging/production, enabling signup additionally requires private `AUTH_SIGNUP_SUBJECTS`, a JSON string with 1–5 unique exact verified Google subjects; missing/malformed policy fails closed. This gates new accounts only: returning sign-in/reauth are independent, signup=false blocks new accounts, and admission grants no operator roles. Subject values are excluded from readiness/logs. Provider credentials and redirect registration are external setup; test fixtures do not establish a connected Google client.

Local invitation login (`POST /api/session`) is unavailable in staging/production. `GET /api/auth/status` reports safe sign-in configuration, local invitation availability and an optional approved Apple entry URL. It contains no credentials.

For local setup, use [Google sign-in setup](google-signin-setup.md) and `npm run configure:identity`. The command consumes a protected downloaded Google web-client file with the exact local redirect, preserves existing encryption and provider settings, and enables local signup only when explicitly selected. It makes no Google request and does not configure cloud clients.

## Link a messaging identity

1. Sign in and freshly confirm the account.
2. `POST /api/channel-links` with explicit `replyConsent:true` and independent `proactiveConsent:true|false` creates a five-minute single-use secret code tied to the current session.
3. Send the exact `link plause CODE` through the verified messaging provider. The webhook records possession of the opaque provider/app/user/conversation tuple. The code and proof message are excluded from agent history.
4. Inspect `GET /api/channel-links/:id`, then explicitly `POST /api/channel-links/:id/confirm` from the same original fresh session. Only confirmation creates the active binding.
5. Inspect `GET /api/channel-bindings`; `DELETE /api/channel-bindings/:id` requires fresh confirmation and revokes the binding and pending work.

The browser never supplies an arbitrary provider subject. Proof event IDs cannot also become agent/lifecycle events. A subject cannot be reassigned to another account. Active provider destinations are unique; moving a destination requires explicit revocation. Relinking to a different provider thread fences old model work, inbox/outbox jobs and staff claims. Old uncertain sends remain uncertain and are excluded from the new ownership epoch. Delayed events older than the authenticated provider proof cannot introduce previous account history into a newly linked account. The provider clock supplies this replay boundary; server timestamps still document verification.

Only a configured `https://bcrw.apple.com/urn:biz:UUID` entry link is displayed. The secret code is never appended to it. Actual Apple approval, brand ID and on-device opening remain external acceptance checks.

## Staff workflow

A customer support request pauses generated replies. Cloud customers cannot resume bot ownership themselves. The service sends a fixed support acknowledgment when its own provider control still permits a reply; configured coverage copy never guarantees live staffing or a response time.

Staff access requires a current verified Google session confirmed within five minutes and an active `admin` or `support` grant. Local invitation sessions can serve as fixtures only locally. Initial admins may be bootstrapped from an exact Google subject allowlist; email is not used. A revoked grant is never silently restored from that list.

| Route | Purpose |
| --- | --- |
| `GET /api/operator/capabilities` | Safe current role/capability state. |
| `GET /api/operator/support` | Metadata for bounded human-support inbox. |
| `POST /api/operator/support/:id/claim` with `{}` | Acquire a five-minute exclusive versioned claim. |
| `GET /api/operator/support/:id?before=ROWID` | Claimed conversation transcript; opaque pagination avoids timestamp collisions. |
| `POST .../renew`, `.../release`, `.../resume` with `{claimVersion}` | Renew/release ownership or explicitly resume automation. |
| `POST .../reply` with `{claimVersion,text,clientMessageId}` | Queue one stable-ID staff reply. |
| `GET/POST /api/operator/grants` | Admin role inspection/change; POST takes `{userId,role:"admin"|"support"|null}`. |
| `GET /api/support/coverage` | Configured public hours/zone/contact; never a staffing-presence assertion. |

Grant revision, claim version/expiry, operator account status, customer context, provider ownership and conversation lease remain send-time gates. Losing a role or claim cancels queued staff replies; an already dispatched outcome becomes unknown. Human messages retain an opaque author marker even after staff account deletion and never become AI messages through a null foreign key. On Sunshine they omit the AI author subtype. Provider-owned/unknown-control threads cannot be claimed or replied to by the Plause staff client until control is resolved. No external staff notification or message has been sent by this implementation work.

The web client provides sign-in, reauthentication, linking/revocation and staff controls. Static safe-DOM tests and API fixtures pass; actual browser visual/interaction QA is still outstanding.
