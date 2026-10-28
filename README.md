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
- **Selectable currency** — pick a display currency (INR, USD, EUR, …) from the dashboard or keys card; prices are re-fetched from IsThereAnyDeal in that currency's store region and re-labelled
- **Big libraries** — Epic's catalog is fetched page by page with live progress, so huge accounts never hang a single request
- **Non-game filtering** — DLC, soundtracks, Unreal Engine builds, and Epic store content for UE (Fab/marketplace plugins, Megascans, projects) are excluded — only real games are listed
- **In-browser only** — tokens stay in your browser localStorage; no server-side user data
- **Privacy** — "Forget my data" clears everything instantly

## Quick start

### Local dev

```bash
pip install -r api/requirements.txt -r requirements-dev.txt
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
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated origins allowed to call this API cross-origin, e.g. `https://your-site.netlify.app`. Empty — the default — means same-origin only. Wildcards are discarded rather than honoured. |
| `REQUIRE_USER_KEYS` | No | `1` to ignore the server's `STEAM_API_KEY` / `ITAD_API_KEY` / `PLATPRICES_API_KEY` / `SGDB_API_KEY` and require every visitor to bring their own. Set this on any public deployment. |
| `TRUST_PROXY` | No | `1` to read the client IP from `X-Forwarded-For`. Only behind a reverse proxy you control — otherwise the per-IP rate limit is trivially bypassed. |
| `RATE_LIMIT_PER_MIN` | No | Per-IP requests per minute (default 120). |
| `PUBLIC_BASE_URL` | No | The URL the app is reached on. OAuth redirect URIs (GOG, Epic) must match what those providers have registered. |

## Going public

Netlify cannot run this backend: its Functions support TypeScript, JavaScript
and Go, and there is no Python runtime. The two halves therefore deploy
separately.

```
browser ──► Netlify          public/ only (html, js, css)
   └──────► Render           server.py + api/ (Dockerfile)
```

The frontend reaches the API **directly** rather than through Netlify's
`/api/*` proxy rewrite. That rewrite caps requests at 26 seconds, which a cold
price scan can exceed, and it would place every visitor behind Netlify's edge
IP and defeat the backend's per-IP rate limiting.

**Backend** — `render.yaml` is provided. Render creates services without
payment information on file, and the existing `Dockerfile` deploys unchanged:

1. Push the repo, then connect it to Render (New → Blueprint).
2. Render reads `render.yaml`, which already sets `HOST`, `REQUIRE_USER_KEYS`
   and `CORS_ALLOWED_ORIGINS`, and binds `/api/health` as the health check.
3. Note the resulting `*.onrender.com` URL — it goes in `BACKEND_URL` below.

Free-tier caveat: the instance spins down after 15 idle minutes and takes about
a minute to wake, and Render may restart it at any time. Nothing depends on
surviving a restart; the server keeps no state on disk.

Set `PLATPRICES_API_KEY` and friends as Render env vars only if you want a
shared server-side key. With `REQUIRE_USER_KEYS=1` they are a fallback, and
bring-your-own-key is the intended public posture.

**Frontend** — set `BACKEND_URL` in the Netlify UI (Site configuration →
Environment variables) to the API origin. The build rewrites `public/js/env.js`
and emits `public/_headers` with a CSP naming that host, so `BACKEND_URL` is
the only thing to configure.

Before inviting anyone, read **[SECURITY.md](SECURITY.md)**. Two things
especially: `REQUIRE_USER_KEYS=1` is what stops every visitor spending your API
quota, and PlayStation support means users paste a PSN session token into
your site.

## Tests

```bash
python -m unittest discover -s tests
node --test public/js/*.test.mjs tests/js/*.test.mjs   # or: npm test
```

## License

MIT
