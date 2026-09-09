# Library Aggregator (runs entirely locally)

Aggregates a game library across Steam, GOG, and Epic Games, showing
total value in ₹ via IsThereAnyDeal pricing. Runs entirely on your own
machine — no cloud account, no hosting platform, no login of any kind.
No history/database — each scan is a live snapshot.

## Running it

1. Install dependencies:
   ```
   pip install -r api/requirements.txt -r requirements-dev.txt
   ```
2. Create a `.env` file in the project root:
   ```
   STEAM_API_KEY=your_key_here
   ITAD_API_KEY=your_key_here
   ```
   - Steam key: https://steamcommunity.com/dev/apikey
   - ITAD key: https://isthereanydeal.com/apps/my/
   - No GOG or Epic key needed — their public client credentials are
     already in the code (see `api/gog_exchange.py` and
     `api/epic_exchange.py` for the source), overridable via
     `GOG_CLIENT_ID`/`GOG_CLIENT_SECRET` and
     `EPIC_CLIENT_ID`/`EPIC_CLIENT_SECRET` if ever needed.
3. Run:
   ```
   python dev_server.py
   ```
4. Open http://localhost:3000

This only runs while `dev_server.py` is active in a terminal — it's a
tool you start when you want to check your library, not an always-on
website. If you ever want it reachable without manually starting it
each time, that's a separate step (running it as a background service)
and not something this setup does out of the box.

## How linking works

- **Steam**: click "link account" → real Steam login page → redirected
  back automatically with a verified SteamID. No key ever touches the
  browser.
- **GOG**: click "link account" → GOG's real login page opens in a new
  tab → after logging in, GOG redirects to a page whose URL contains
  `?code=...` → copy that code and paste it into the form on our page.
- **Epic Games**: click "link account" → Epic's real login page opens in
  a new tab → after logging in, you land on a page showing raw JSON
  containing `"authorizationCode"` → copy that value and paste it into
  the form on our page.

<!-- Both GOG and Epic's manual-paste step is unavoidable: neither service's
redirect target is something we control, so there's no way to
auto-capture the code from a plain website the way Steam's OpenID flow
allows. -->

Linked account identifiers/tokens are stored in the browser's
`localStorage` only — nothing is persisted server-side, consistent with
there being no database.

<!-- ## Why Ubisoft Connect isn't included

Ubisoft has no OAuth surface at all. The only paths other tools use
involve session-cookie capture or hitting a private API with credentials
directly — a meaningfully bigger security responsibility than the app
should take on. Steam, GOG, and Epic all have some form of real or
community-documented OAuth-style flow; Ubisoft has neither. -->

<!-- ## Known limitations

- **GOG game count is capped at 40 per scan** (`MAX_GAMES` in
  `api/gog_games.py`) to stay within a serverless function's execution
  time limit, since each game needs a separate name-lookup call. Response
  includes `"truncated": true` if the library is bigger.
- **Epic library fetch is capped at 5 pages** (`MAX_PAGES` in
  `api/epic_games.py`) for the same reason. Epic game names come from
  each item's metadata when present; items without metadata fall back to
  their internal app name (less readable) rather than an extra lookup
  call per game.
- **Price lookups are batched at 25 titles per call** to the same
  timeout constraint (`MAX_TITLES` in `api/prices.py`); the frontend
  calls `/api/prices` in batches automatically.
- **Price matching is by title string** — unusual titles may not match
  well in ITAD's lookup.
- The GOG and Epic client IDs/secrets are publicly known constants baked
  into every real GOG Galaxy / Epic Games Launcher install (documented at
  https://github.com/Yepoleb/gogapidocs and used by the open-source
  `legendary` project respectively), not something either company issued
  to this app specifically — both integrations are unofficial and could
  break if either service changes their auth flow. -->
