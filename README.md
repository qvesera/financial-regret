# financial-regret

A browser-based dashboard that shows how much you have spent on games versus how much you have actually played them — a "regret" metric, in any currency you choose (INR by default).

**No setup required.** Runs entirely in the browser after connecting your store accounts.

## Features

- **Steam, GOG, Epic Games, Amazon Luna** — Steam auto-redirects (OpenID); GOG, Epic and Amazon land you on the provider's own domain (none allow a custom redirect URI for their public/device client), so the code is collected by paste. Amazon has no public library API, so it registers a virtual Games-launcher device (undocumented / alpha) and, having no playtime API, its rows are priced but excluded from per-hour ratios
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
| `SGDB_API_KEY` | No | SteamGridDB key used as the fallback for cover art. A browser-supplied key (dashboard → API keys → SteamGridDB) takes precedence and is sent per-request as `X-SGDB-Key`; without either, the covers endpoint returns no art. |
| `GOG_CLIENT_ID` | No | GOG OAuth client ID. Defaults to public PKCE client. |
| `EPIC_CLIENT_ID` | No | Epic OAuth client ID. Defaults to public PKCE client. |
| `PORT` | No | Port to listen on (default 3000; `run.sh` passes 8089). |
| `HOST` | No | Host to bind (default 0.0.0.0). |

## Tests

```bash
python -m unittest discover -s tests
node --test public/js/*.test.mjs tests/js/*.test.mjs   # or: npm test
```

## License

MIT
