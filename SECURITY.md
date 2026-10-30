# Security posture

What protects credentials here, what does not, and what an operator must
decide before putting this on the public internet.

## Scope

`financial-regret` is a **stateless proxy with a static frontend**. There are
no accounts, no cookies, no sessions, no database and no writes to the
filesystem anywhere in `server.py` or `api/` — grep for `open(`, `sqlite`,
`pickle` or a `Path(...)` write and you will find none. Every request is
authenticated by whatever the caller brings with it, and forgotten when the
response goes out.

That shape is the whole security model. It is also why a public deployment is
tractable at all.

## Threat model

The realistic bad outcomes are, in order: a stranger spends someone else's API
quota; a malicious website drives the API using a visitor's stored credentials;
a log aggregator ends up holding someone's PSN token; the server host is
compromised and credentials in flight are captured. The first three are
addressed below. The last is not solvable — see *Residual risks*.

## What the server sees

Every credential is a **request-scoped secret**. None is written to disk and
none is kept in a cache.

| Source | Credential | Arrives in | Lives until |
|---|---|---|---|
| Steam | Web API key | `X-Steam-Key` header | response sent |
| IsThereAnyDeal | ITAD key | `X-ITAD-Key` header | response sent |
| PlatPrices | PlatPrices key | `X-Platprices-Key` header | response sent |
| SteamGridDB | SGDB key | `X-SGDB-Key` header | response sent |
| GOG | OAuth access + refresh | `X-GOG-Token`, `X-GOG-Refresh` | response sent |
| Epic | OAuth access + refresh | `X-Epic-Token`, `X-Epic-Refresh` | response sent |
| Amazon | device bearer token | `X-Amazon-Token` header | response sent |
| **PlayStation** | **NPSSO cookie** | **JSON body of `POST /api/psn_exchange`** | exchange completes |
| PlayStation | OAuth access + refresh | `X-PSN-Token`, `X-PSN-Refresh` | response sent |

The browser is the only durable copy: it keeps OAuth tokens in `localStorage`
under keys like `psn_access_token`, and reads them back for the next request.

Credentials are **never placed in a URL**. `public/js/api.js` opens with that
rule, and `tests/test_logging.py` pins the consequence.

## Guarantees the code makes

* **Nothing is logged.** `DevRequestHandler.log_message` strips the query
  string from the progress line *and* from the inherited access-log line, which
  would otherwise write `self.requestline` verbatim. `tests/test_logging.py`
  asserts that a secret in a query string never reaches the log line.
* **Nothing is persisted.** See *What the server sees*. Restarting the process
  discards every cache.
* **Cross-origin access is opt-in per origin.** `api/_cors.py` echoes back only
  an origin named in `CORS_ALLOWED_ORIGINS` — never a wildcard, and never
  `Access-Control-Allow-Credentials`. A stray `*` or `null` in the allowlist is
  discarded rather than honoured, so a copy-paste mistake is inert. The
  preflight header list is checked against the real client headers by
  `tests/test_cors.py`, so the two cannot drift.
* **A strict CSP ships.** `default-src 'self'`, no webfonts, no inline scripts —
  from `server.py` when self-hosted, and from the `headers` block in
  `vercel.json` on Vercel.
* **Paths cannot escape `public/`.** Every dot segment is rejected up front and
  the resolved path is checked against the resolved root.
* **Per-IP rate limiting** on every endpoint, including `OPTIONS`.
* **The operator's keys are shared by default — and visitors can spend them.**
  `user_key()` prefers the caller's own header key and falls back to the
  server-side `STEAM_API_KEY`, `ITAD_API_KEY`, `PLATPRICES_API_KEY` and
  `SGDB_API_KEY`, so an instance works without setup. `REQUIRE_USER_KEYS=1`
  removes that fallback: a visitor with no key is refused instead of billed
  against your quota. A provider's 429 is reported to the browser as
  "rate-limited" along with the way to bring a key, so a spent pool reads as a
  spent pool rather than a blank price column. See `tests/test_user_keys.py`.

### Not a secret, despite looking like one

`api/epic_exchange.py` and `api/gog_exchange.py` carry default `CLIENT_SECRET`
values. These are the providers' own public application credentials, published
in their client-side integrations and in countless open-source projects. They
identify the application, not a user. Override them if you register your own
app; do not treat their presence in the repository as a leak.

## PlayStation: the decision to keep it public

This is the one credential that is not an API key. An **NPSSO token is a PSN
web session**: whoever holds it is signed in as that account, and users are
asked to paste one into this application.

The decision is to keep PlayStation support on public deployments, on this
basis:

* **The pasted token is exchanged, not stored.** `api/psn_exchange.py` turns it
  into a Sony access + refresh token pair and returns those to the browser. The
  NPSSO itself is not cached, not logged and not persisted.
* **The server never decides what to do with it.** It is an opaque string in a
  request body, forwarded to Sony and then gone.
* **The exposure is therefore the same as any HTTPS request**, plus the standing
  risk that the host is compromised while the request is in flight.

What this does *not* buy you: it does not make pasting a session token a good
idea, and it does not remove your responsibility if the host is breached. The
alternative — dropping PlayStation from public deployments — remains available
and is small: disable the two handlers and rewrite the connect copy.

## Residual risks you accept by going public

1. **Host compromise captures in-flight credentials.** TLS protects the
   transport, not your process. Anyone with root on the machine, or able to read
   a heap dump, can read tokens as they pass. The only real mitigation is not
   handling the credential at all.
2. **Shared in-memory caches cross visitors.** `api/epic_games.py` caches
   playtime keyed by Epic account id; `api/covers.py` caches cover art keyed by
   title. Neither holds secrets, but on a shared instance a visitor who knows
   another visitor's account id could read that visitor's cached playtime.
   Prices are keyed by currency and region and are not user-specific.
3. **`localStorage` is readable by any script on the origin.** The CSP is what
   stops that being an open door; an XSS in the frontend would expose every
   linked account. Treat the CSP as load-bearing.
4. **The providers may object.** When a visitor brings their own key you are a
   *client* acting on their behalf rather than a reseller, which is the
   defensible position. With shared keys as the default, a visitor without one
   spends *your* account instead, and a busy instance can look like exactly the
   thing paid tiers exist to prevent. `REQUIRE_USER_KEYS=1` restores the
   defensible posture at the cost of pricing nothing for anyone who has not
   brought a key. It is not a legal opinion.

## Operator checklist for a public deployment

- [ ] `REQUIRE_USER_KEYS` decided: unset, every visitor can spend your key —
      the caches absorb most of it and the rate-limit note steers heavy users
      to their own; set to `1`, a visitor without a key gets no prices at all.
- [ ] `CORS_ALLOWED_ORIGINS` set to exactly the frontend origin(s), no wildcards.
- [ ] `TRUST_PROXY` **unset** unless a reverse proxy you control is in front.
      Setting it while the API is directly reachable makes the per-IP rate limit
      trivially bypassable by forging `X-Forwarded-For`.
- [ ] `RATE_LIMIT_PER_MIN` reviewed against your instance size.
- [ ] HTTPS only, terminating at the platform edge.
- [ ] Rotate any key you have ever pasted into a shared or public environment.
- [ ] Log shipping reviewed: access logs contain paths, IPs and upstream error
      bodies.
- [ ] GOG/Epic OAuth redirect URIs point at the frontend origin you actually
      deploy.

