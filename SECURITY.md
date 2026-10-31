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
a log aggregator ends up holding an operator key; the server host is
compromised and credentials in flight are captured. The first three are
addressed below. The last is not solvable — see *Residual risks*.

The PlayStation case that used to sit at the top of this list — a visitor's
PSN web session crossing the wire — no longer exists, because no visitor ever
supplies one (see *PlayStation* below).

## What the server sees

Every credential a **caller** brings is a **request-scoped secret**. None is
written to disk and none is kept in a cache. The one standing credential is
the operator's own PlayStation reader token, read from `PSN_REFRESH_TOKEN`
and held in memory between refreshes.

| Source | Credential | Arrives in | Lives until |
|---|---|---|---|
| Steam | Web API key | `X-Steam-Key` header | response sent |
| IsThereAnyDeal | ITAD key | `X-ITAD-Key` header | response sent |
| PlatPrices | PlatPrices key | `X-Platprices-Key` header | response sent |
| SteamGridDB | SGDB key | `X-SGDB-Key` header | response sent |
| GOG | OAuth access + refresh | `X-GOG-Token`, `X-GOG-Refresh` | response sent |
| Epic | OAuth access + refresh | `X-Epic-Token`, `X-Epic-Refresh` | response sent |
| Amazon | device bearer token | `X-Amazon-Token` header | response sent |
| **PlayStation** | **none from the visitor — a public online ID** | **`?onlineId=` query value** | response sent |
| PlayStation | operator's reader refresh token | `PSN_REFRESH_TOKEN` (env) | persistent, by design |

The browser is the only durable copy: it keeps OAuth tokens in `localStorage`
under keys like `psn_access_token`, and reads them back for the next request.
PlayStation is the exception — it holds only `psn_online_id`, a public profile
name.

Credentials are **never placed in a URL**. `public/js/api.js` opens with that
rule, and `tests/test_logging.py` pins the consequence.

## Guarantees the code makes

* **Nothing is logged.** `DevRequestHandler.log_message` strips the query
  string from the progress line *and* from the inherited access-log line, which
  would otherwise write `self.requestline` verbatim. `tests/test_logging.py`
  asserts that a secret in a query string never reaches the log line.
* **Nothing is persisted.** See *What the server sees*. Restarting the process
  discards every cache.
* **Cross-origin access is opt-in per origin.** `backend/_cors.py` echoes back only
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
* **Per-IP rate limiting** on every endpoint, including `OPTIONS` — enforced by
  `server.py` when it serves (local, Docker, Render). The Vercel deployment
  enforces none in-app: add a rate-limiting rule in the Vercel Firewall (one
  free rule per Hobby project, first 1,000,000 allowed requests a month
  included), or set `REQUIRE_USER_KEYS=1` so there is no shared quota to burn.
* **The operator's keys are shared by default — and visitors can spend them.**
  `user_key()` prefers the caller's own header key and falls back to the
  server-side `STEAM_API_KEY`, `ITAD_API_KEY`, `PLATPRICES_API_KEY` and
  `SGDB_API_KEY`, so an instance works without setup. `REQUIRE_USER_KEYS=1`
  removes that fallback: a visitor with no key is refused instead of billed
  against your quota. A provider's 429 is reported to the browser as
  "rate-limited" along with the way to bring a key, so a spent pool reads as a
  spent pool rather than a blank price column. See `tests/test_user_keys.py`.

### Not a secret, despite looking like one

`backend/epic_exchange.py` and `backend/gog_exchange.py` carry default `CLIENT_SECRET`
values. These are the providers' own public application credentials, published
in their client-side integrations and in countless open-source projects. They
identify the application, not a user. Override them if you register your own
app; do not treat their presence in the repository as a leak.

## PlayStation: why no visitor credential exists

An **NPSSO token is a PSN web session**: whoever holds it is signed in as that
account. This project used to ask visitors to paste one, and that is why no
data provider would issue it an API key. A deployed site cannot prove to an
outsider that it runs the published code, so a site that receives session
tokens can be turned into a collector at any time — by its operator or by
whoever compromises it. No amount of "we do not store it" answers that.

The design is now the answer instead of the argument, and
`tests/test_psn_games.py` pins every part of it:

* **No route accepts a PSN credential.** `backend/psn_exchange.py` — the
  handler that took a visitor's NPSSO — is deleted. `GET /api/psn_games` reads
  `?onlineId=` and never consults an `X-PSN-*` header; a test asserts the file
  is gone and the header string is absent from the handler's source.
* **The visitor supplies a public identifier only.** An online ID is the name
  on a profile — data Sony already shows anyone who looks. The PlayStation card
  has no token field and no link to any Sony account endpoint; the test checks
  the card contains neither "NPSSO" nor "ssocookie" and carries no anchors at all.
* **The one credential is yours, and it is not a session.**
  `PSN_REFRESH_TOKEN` is minted on your machine by `scripts/psn_login.py` from
  your own (ideally throwaway) account's NPSSO, then pasted into the
  server's environment. It mints short-lived API access for reading public
  playtime and cannot sign in to the PlayStation website. It is the same
  category as `STEAM_API_KEY` — an operator key, rotatable by running one
  script again.
* **The profile lookup spends no token at all.** `profile2` is asked with no
  `Authorization` header, so even the reader account's quota is reserved for
  the playtime call itself.

What remains honest to say: reading profiles through an unofficial endpoint is
against Sony's wishes if not quite their letter; one reader account's quota is
a real ceiling (mitigated by the 24-hour-style caching elsewhere and your
per-IP limit); and a profile that answers 200 with nothing in it has either
hidden its "gaming history" or only ever played PS3/Vita-era titles this
endpoint does not list — the UI names both causes instead of only the privacy
switch. Those are reliability limits, not credential risks.

## Residual risks you accept by going public

1. **Host compromise captures in-flight credentials.** TLS protects the
   transport, not your process. Anyone with root on the machine, or able to read
   a heap dump, can read tokens as they pass. The only real mitigation is not
   handling the credential at all.
2. **Shared in-memory caches cross visitors.** `backend/epic_games.py` caches
   playtime keyed by Epic account id; `backend/covers.py` caches cover art keyed by
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
- [ ] `RATE_LIMIT_PER_MIN` reviewed against your instance size — it binds
      `server.py` only; on Vercel, confirm the Firewall's rate-limiting rule
      instead, and check it is still active after plan changes.
- [ ] HTTPS only, terminating at the platform edge.
- [ ] Rotate any key you have ever pasted into a shared or public environment.
- [ ] Log shipping reviewed: access logs contain paths, IPs and upstream error
      bodies.
- [ ] GOG/Epic OAuth redirect URIs point at the frontend origin you actually
      deploy.

