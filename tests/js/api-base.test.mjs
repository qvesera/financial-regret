import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  apiUrl, fetchConfig, fetchSteamGames, fetchGogGames, fetchEpicGames,
  fetchPsnGames, fetchAmazonGames, shortenUrl,
} from "../../public/js/api.js";

// api.js reaches for localStorage; the module has no other global deps.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const CLIENT_FILES = ["../../public/js/api.js", "../../public/js/app.js"];

test("apiUrl leaves paths relative, which is what the dev server expects", () => {
  // env.js ships empty on purpose: server.py serves public/ and /api from one
  // process, so a self-hosted install needs no configuration at all.
  assert.equal(apiUrl("/api/config"), "/api/config");
  assert.equal(apiUrl("/api/steam_games?steamid=42"), "/api/steam_games?steamid=42");
});

test("fetchConfig resolves through apiUrl rather than hard-coding a path", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ publicBaseUrl: "x" }) };
  };

  await fetchConfig();
  assert.deepEqual(calls, [apiUrl("/api/config")]);
});

test("no call site talks to /api without going through apiUrl", async () => {
  // A bare fetch("/api/...") would ignore the configured backend and fail as a
  // same-origin request against the CDN host, which reads as a silent outage.
  const offenders = [];
  for (const rel of CLIENT_FILES) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/fetch\(\s*["'`]\/api\//.test(line)) offenders.push(`${rel} #${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("an HTML error page is reported as the status, never as a parse crash", async () => {
  // Vercel's platform-level failures answer in HTML. Every client must check
  // resp.ok before .json(), or boot sees SyntaxError instead of "config 500".
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
  });
  await assert.rejects(fetchConfig(), /config 500/);
  await assert.rejects(fetchSteamGames("42"), /steam_games 500/);
});

test("Epic's rate limit reads as a sentence a person can act on", async () => {
  const mem = new Map([["epic_access_token", "tok"]]);
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(fetchEpicGames(), /wait a minute/);
});

test("credentials never ride in the URL", async () => {
  // api.js's header promise: "All tokens travel in headers or JSON bodies —
  // never in URLs." URLs end up in access logs, history and Referer headers.
  // PlayStation deliberately sits out this list: it has no token at all. Its
  // online ID is public profile data, asserted just below by its presence.
  const secrets = ["SECRET-STEAM", "SECRET-GOG", "SECRET-EPIC", "SECRET-AMZN"];
  const mem = new Map([
    ["steam_api_key", secrets[0]], ["gog_access_token", secrets[1]],
    ["epic_access_token", secrets[2]], ["amazon_access_token", secrets[3]],
    ["psn_online_id", "PublicPlayer_91"],
  ]);
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ games: [] }) };
  };

  await fetchSteamGames("7656119");
  await fetchGogGames();
  await fetchEpicGames();
  await fetchPsnGames();
  await fetchAmazonGames();

  assert.ok(calls.length >= 5, `five clients called, got ${calls.length}`);
  for (const { url } of calls) {
    for (const secret of secrets) {
      assert.ok(!url.includes(secret), `${secret} appeared in ${url}`);
    }
  }
  // The one identifier that does ride a query string, because a PSN online ID
  // is profile data anybody can already look up — not a credential.
  const psn = calls.find((c) => c.url.includes("/api/psn_games"));
  assert.ok(psn, "PlayStation was called");
  assert.ok(psn.url.includes("onlineId=PublicPlayer_91"), psn.url);
});

test("shortening trusts is.gd's answer and nothing else's", async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ shorturl: "https://is.gd/ab12" }),
  });
  assert.equal(await shortenUrl("https://x/#card=y"), "https://is.gd/ab12");

  // The short URL is what gets displayed and copied; it must never be a host
  // this app did not name, or a redirect becomes an open door.
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ shorturl: "https://evil.example/x" }),
  });
  assert.equal(await shortenUrl("https://x/#card=y"), null);

  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  assert.equal(await shortenUrl("https://x/#card=y"), null,
    "a refusal is no short link");

  globalThis.fetch = async () => { throw new Error("blocked by the network"); };
  assert.equal(await shortenUrl("https://x/#card=y"), null,
    "a network failure reads as no short link");
});
