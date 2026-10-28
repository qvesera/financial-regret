import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apiUrl, fetchConfig } from "../../public/js/api.js";

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
