# Public web research

Research is implemented for the local web and mock messaging preview. It is off by default. No provider account or live API acceptance test is included in automated validation.

Send one unquoted command on one line:

```
search: public library opening hours
research: latest public mission announcement
research help
```

Queries are limited to 300 UTF-16 code units. Only the explicit query is sent to Tavily. Chat history, saved facts, account details and other messages are excluded. Search is an ordered conversation turn, so it follows human handoff, closure, ownership, pause and context privacy fences. Ordinary chat daily limits still apply.

Results contain at most five source snippets with HTTPS links. The service does not open the result pages, verify their claims, follow instructions in snippets, perform actions or generate additional queries. Treat source content as untrusted evidence. Unsafe, credential-bearing and obvious internal-address links are removed. Domain links are filtered syntactically; no DNS lookups or destination requests are performed.

## Configuration

The optional configuration fields are:

| Field | Default | Accepted value |
| --- | --- | --- |
| `SEARCH_PROVIDER` | `disabled` | `disabled` or `tavily` |
| `LIVE_SEARCH_ENABLED` | `false` | `true` explicitly enables calls |
| `TAVILY_API_KEY` | absent | secret configured separately |
| `SEARCH_USER_DAILY_LIMIT` | `20` | integer 1–100 |
| `SEARCH_GLOBAL_DAILY_LIMIT` | `500` | integer 1–5000 |

The runtime additionally requires `APP_ENV=local` and `MESSAGING_PROVIDER=mock`. Missing configuration produces an honest connection limitation without an external attempt. Health readiness exposes flags and status, never the key. Keep secrets out of source control and command arguments.

Inspect configuration with `npm run configure:search -- --status`. To opt in, place your Tavily key in a private regular file owned by you, set its permissions to `600`, and run `npm run configure:search -- --key-file .local/tavily-key.txt --enable`. Disable requests with `npm run configure:search -- --disabled`. These commands do not make an API request. Restart the local server after changing configuration.

## Provider boundary

The adapter sends one POST to `https://api.tavily.com/search`, rejects redirects and uses a bearer credential. It fixes `search_depth=basic`, `topic=general`, `max_results=5`, and disables automatic parameters, answers, raw content, images, image descriptions and favicons. The whole request, response stream and decoding share a ten-second deadline; the body is limited to 128 KiB. Provider response bodies and network error text are excluded from errors.

The official [Tavily Search API reference](https://docs.tavily.com/documentation/api-reference/endpoint/search) defines these request fields and the results schema. Tavily currently lists basic search as one credit per request in its [API credits documentation](https://docs.tavily.com/documentation/api-credits), reviewed October 30, 2026. These application limits count requests; they do not assert an exact bill or account balance. Tavily’s separate Research API is not used.

## Durability and privacy

An atomic D1 insertion claims each source message and checks both UTC daily quotas before dispatch. All claimed attempts count, including rejected, uncertain and purged outcomes. Concurrent conversations cannot exceed the application caps. Deleting messages or an account retains opaque request metadata so deletion cannot refund the global quota.

Each accepted search input gets at most one provider attempt. A completed result is encrypted and can be reused after a crash before the conversation reply commits. A crash during dispatch, timeout, unknown response or definitive rejection leaves a terminal tombstone: automatic recovery does not make another paid request for that input. An explicit new command is a new request and consumes quota.

Cached reads require the current tenant, source message, conversation lease, bot ownership and privacy revision. Memory changes and account or transcript deletion purge cached content. A response arriving after privacy revocation retains its quota record while its result is discarded. Conversation commit and delivery perform their own final fences; a completed HTTP request does not itself authorize an outbound reply. Already transmitted public queries cannot be recalled from the provider.

Automated tests use synthetic fetch fixtures only. They cover the fixed request, bounded bodies and deadlines, unsafe links, parser boundaries, concurrent quotas, cache recovery, tenant isolation, revocation and retained quota metadata.
