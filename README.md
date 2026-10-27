# financial-regret

A browser-based dashboard that shows how much you have spent on games versus how much you have actually played them — a "regret" metric, in any currency you choose (INR by default).

**No setup required.** Runs entirely in the browser after connecting your store accounts.

## Features

- **Steam, GOG, Epic Games** — Steam auto-redirects (OpenID); GOG and Epic land you on the provider's own domain (neither allows a custom redirect URI for its public client), so the code is collected by paste
- **Real regret metric** — library value, backlog value (unplayed), regret score, and coverage, all shown in your chosen currency
- **Selectable currency** — pick a display currency (INR, USD, EUR, …) from the dashboard or keys card; prices are re-fetched from IsThereAnyDeal in that currency's store region and re-labelled
- **Big libraries** — Epic's catalog is fetched page by page with live progress, so huge accounts never hang a single request
- **Paid-override** — optionally enter what you actually paid per game
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
