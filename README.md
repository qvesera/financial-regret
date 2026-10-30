# financial-regret

A browser-based dashboard that shows how much you have spent on games versus how much you have actually played them — a "regret" metric, in any currency you choose (INR by default).

**No setup required.** Runs entirely in the browser after connecting your store accounts.

## Features

- **Steam, GOG, Epic Games, Amazon Luna** — Steam auto-redirects (OpenID); GOG, Epic and Amazon land you on the provider's own domain (none allow a custom redirect URI for their public/device client), so the code is collected by paste. Amazon has no public library API, so it registers a virtual Games-launcher device (undocumented / alpha) and, having no playtime API, its rows are priced but excluded from per-hour ratios
- **PlayStation** — owned-and-played titles via the community gamelist endpoint (Sony offers no official library API, so sign-in comes first). Prices come from **PlatPrices**, joined on the PSN title id rather than the title text. They only appear when a `PLATPRICES_API_KEY` is set — without one the rows still count toward playtime, they simply render as Unpriced
- **Real regret metric** — library value, backlog value (unplayed), regret score, and coverage, all shown in your chosen currency
- **Verdict engine** — every game is judged against *your own* library's price-per-hour quartiles (worth it / fair / regret / untouched), so the thresholds follow how you spend rather than a hardcoded number. It surfaces as a box plot of the distribution, a badge on every row and card, and a plain-language explanation in the game inspector
- **What-if slider** — replay any regrettable purchase at 1–60 hours and watch its rate and verdict change
- **Faceted browsing** — filter by play status, platform or verdict, sort, and switch between the list and the cover-art grid; your filters survive a reload
- **Selectable currency** — one display-currency picker in the header (INR, USD, EUR, …), defaulted from your region when the edge reports it; prices are re-fetched from IsThereAnyDeal in that currency's store region and re-labelled
- **Card sharing** — Wrapped-style PNG cards in the arcade skin: a summary deck, the ranked lists, one card per verdict, or whatever your current filters show. Download them, share the image directly, or copy a link that opens the exact card for whoever receives it — the card carries the wordmark and the project's home, nothing more
- **Big libraries** — Epic's catalog is fetched page by page with live progress, so huge accounts never hang a single request
- **Non-game filtering** — soundtracks, Unreal Engine builds, and Epic store content for UE (Fab/marketplace plugins, Megascans, projects) are excluded — only real games are listed
- **Add-on (DLC) tracking** — add-ons and expansions are kept and badged, then tallied in their own **Add-on value** figure rather than mixed into library value or the regret score (DLC has no playtime of its own — you play it inside its base game — so counting it would make unopened base games look like the problem). Reachable today on **Epic** (base-game pointer) and **Amazon** (title match), best-effort on **GOG**. **Steam**'s public API exposes no owned-DLC list and **PlayStation** has no DLC price source, so those stores contribute no add-on rows
- **In-browser only** — tokens stay in your browser localStorage; no server-side user data
- **Privacy** — "Forget my data" clears everything instantly

## Quick start

### Local dev

```bash
pip install -r requirements.txt -r requirements-dev.txt
./run.sh            # http://localhost:8089  (or ./run.sh <port>)
```

### Docker

```bash
docker build -t financial-regret .
docker run -p 8080:8080 -e ITAD_API_KEY=your_key financial-regret
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ITAD_API_KEY` | No | IsThereAnyDeal API key for price lookups. Without it, prices fall back to Steam public API. |
| `PLATPRICES_API_KEY` | No | PlatPrices key for PlayStation Store prices. Free and Indie plans cap at 2 regions and 1,000 requests/month. Without it PSN rows are unpriced (playtime is unaffected); a browser-supplied key takes precedence, sent per-request as `X-Platprices-Key`. The free plans require crediting PlatPrices wherever the data is shown. **A key may only query the store regions it has been configured for** — free allows 2, reconfigured at most once a day via `PUT /account/regions` — so a library priced in INR needs `in` on that list or it returns nothing at all. |
| `SGDB_API_KEY` | No | SteamGridDB key used as the fallback for cover art. A browser-supplied key (dashboard → API keys → SteamGridDB) takes precedence and is sent per-request as `X-SGDB-Key`; without either, the covers endpoint returns no art. |
| `GOG_CLIENT_ID` | No | GOG OAuth client ID. Defaults to public PKCE client. |
| `EPIC_CLIENT_ID` | No | Epic OAuth client ID. Defaults to public PKCE client. |
| `PORT` | No | Port to listen on (default 3000; `run.sh` passes 8089). |
| `HOST` | No | Host to bind (default 0.0.0.0). |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated origins allowed to call this API cross-origin, e.g. `https://your-app.vercel.app`. Empty — the default — means same-origin only. Wildcards are discarded rather than honoured. |
| `REQUIRE_USER_KEYS` | No | `1` to ignore the server's `STEAM_API_KEY` / `ITAD_API_KEY` / `PLATPRICES_API_KEY` / `SGDB_API_KEY` and require every visitor to bring their own. Unset — the default — a visitor's own key always wins and the server key fills in when they have none, so the instance works without setup. Set `1` on a public deployment where you would rather refuse than spend your quota. |
| `TRUST_PROXY` | No | `1` to read the client IP from `X-Forwarded-For`. Only behind a reverse proxy you control — otherwise the per-IP rate limit is trivially bypassed. |
| `RATE_LIMIT_PER_MIN` | No | Per-IP requests per minute (default 120), enforced by `server.py` — local, Docker and Render. The Vercel function enforces no app-level limit; the equivalent there is a rate-limiting rule in the Vercel Firewall (one free rule per Hobby project, first 1,000,000 requests a month included). |
| `PUBLIC_BASE_URL` | No | The URL the app is reached on. OAuth redirect URIs (GOG, Epic) must match what those providers have registered. |

## Going public

One deployment serves everything: Vercel runs the static site and the API
from the same origin.

```
browser ──► Vercel   public/ (html, js, css)
   └─ /api/* ──► api/index.py ──► backend/   (one Python function)
```

**Deploy** — only when asked. Deploys consume the build budget, so nothing
ships as a side effect of a push: Render's `autoDeploy` is off in the
blueprint, Vercel's Git integration should be switched off in its dashboard,
and releases run by hand — connect the repo in the Vercel dashboard, or run
the CLI:

```bash
vercel deploy --prod
```

`vercel.json` declares the rest: `outputDirectory` is `public/`, `/api/*`
rewrites to the single Python function (300-second budget — a cold price scan
fits), and the security headers (`nosniff`, `Referrer-Policy`, frame denial,
strict CSP) ship on every response. Same origin by construction: no CORS
surface, no `BACKEND_URL` to configure. The per-IP rate limit belongs to
`server.py` and does not run here — on Vercel, add the equivalent as a
rate-limiting rule in the Firewall (one free rule per Hobby project).

The display currency starts from the visitor's region: the edge's country
header (Vercel's `x-vercel-ip-country`, Cloudflare's `cf-ipcountry`) rides on
`/api/config` and is mapped to a currency the picker offers. A self-hosted
`server.py` reports none and keeps the INR default, and a currency the visitor
picked is never overridden. The landing-page demo converts its INR figures as
a fallback, but anchors them on the hero game's real regional price whenever
the instance can price it — regional pricing is not an exchange rate.

**Optional long-running backend** — `render.yaml` plus the root `Dockerfile`
run `server.py` as a persistent service, for libraries so large that a scan
outgrows Vercel's function cap. Push the repo, then connect it to Render
(New → Blueprint); it reads `HOST`, `REQUIRE_USER_KEYS` and
`CORS_ALLOWED_ORIGINS` from the blueprint and health-checks `/api/health`.
Free-tier caveat: the instance spins down after 15 idle minutes and takes
about a minute to wake, and Render may restart it at any time — nothing
depends on surviving a restart, the server keeps no state on disk. To point
the frontend at it, set `API_BASE` in `public/js/env.js` to that
`*.onrender.com` origin and name the same origin in `CORS_ALLOWED_ORIGINS`.

Set `PLATPRICES_API_KEY` and friends as env vars to give visitors a shared
server-side key. A visitor's own key always wins, so theirs is spent first and
the shared one only fills in; when the shared pool runs out the dashboard says
so and points at API keys rather than leaving a blank price column. Set
`REQUIRE_USER_KEYS=1` if you would rather refuse than share at all.

Before inviting anyone, read **[SECURITY.md](SECURITY.md)**. Two things
especially: without `REQUIRE_USER_KEYS=1` every visitor spends your API quota
(the rate-limit note is what tells them to bring their own), and PlayStation
support means users paste a PSN session token into your site.

## Tests

```bash
python -m unittest discover -s tests
node --test public/js/*.test.mjs tests/js/*.test.mjs   # or: npm test
```

## Author

Built by [qvesera](https://github.com/qvesera). Source: [github.com/qvesera/financial-regret](https://github.com/qvesera/financial-regret).

Also contributed: [void-a11y](https://github.com/void-a11y).

This project stands with Palestine. Free Palestine.

## License

MIT
