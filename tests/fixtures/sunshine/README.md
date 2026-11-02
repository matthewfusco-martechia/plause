# Sunshine Conversations contract fixtures

The `official-*.json` files are the functional JSON examples in Zendesk's official [Sunshine Conversations OpenAPI specification](https://github.com/zendesk/sunshine-conversations-api-spec/blob/0f88aea8db3653a19b192407ecf0b2bf262743ad/openapi.yaml), version 17.13.2, reviewed October 31, 2026. They retain the original example app/user/conversation IDs and Telegram/Twilio channels. They contain published example values, not customer records or usable credentials.

Tests construct **synthetic Apple variants** by changing channel type and integration ID to the documented Apple channel values. These validate schema interpretation; they do not establish that an enrolled Apple channel has emitted these exact payloads. Unknown event fields are tolerated, while required routing/identity/event fields are validated. Provider acceptance requires captured redacted fixtures and end-to-end checks against the configured Apple integration.

The example secret/API credentials in the test source are locally invented and never used for network access.
