/**
 * Mobile layout check — renders the app at phone and tablet widths, fails on
 * horizontal overflow (the mechanical cause behind "everything overlaps"), and
 * writes screenshots so a layout can be looked at rather than argued about.
 *
 *   npm run shots     →  shots/*.png
 *
 * The dashboard is seeded through a localStorage snapshot — exactly how a
 * returning visitor boots — so nothing here needs a live store or a scan.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const PORT = process.env.SHOTS_PORT || "8123";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL("../shots/", import.meta.url).pathname;

const VIEWPORTS = [
  { name: "phone-360", width: 360, height: 740 },
  { name: "phone-412", width: 412, height: 892 },
  { name: "tablet-768", width: 768, height: 1024 },
];

const SNAPSHOT = {
  v: 1,
  at: Date.now(),
  currency: "INR",
  games: [
    { id: "Steam:1", name: "Hades", platform: "Steam", hours: 40, appid: 1145360, price: 1113 },
    { id: "Steam:2", name: "Cyberpunk 2077", platform: "Steam", hours: 0, appid: 1091500, price: 1855 },
    { id: "Epic:1", name: "Hades", platform: "Epic", hours: 3, price: 700 },
    { id: "Steam:3", name: "Elden Ring", platform: "Steam", hours: null, appid: 1245620, price: 1457 },
  ],
  prices: { "Steam:1": 1113, "Steam:2": 1855, "Epic:1": 700, "Steam:3": 1457 },
};

const failures = [];

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("server never came up");
}

/** The whole point of the harness: a page that scrolls sideways is the bug. */
async function checkOverflow(page, label, viewport) {
  const { doc, win } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  if (doc > win + 1) {
    failures.push(`${label} @ ${viewport.width}px: scrolls sideways (${doc}px of content in ${win}px)`);
  }
}

/** Text wider than its box with no clipping rule — reported, not failed: it
 *  names what to look at in the screenshot. */
async function reportClippedText(page, label, viewport) {
  const clipped = await page.evaluate(() => [...document.querySelectorAll(
    "p, span, h1, h2, h3, button, td, th, div, li")]
    .filter((el) => {
      const cs = getComputedStyle(el);
      return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2
        && cs.overflow === "visible";
    })
    .slice(0, 8)
    .map((el) => `    ${el.tagName.toLowerCase()}.${el.className || "?"}: `
      + `${String(el.textContent).trim().replace(/\s+/g, " ").slice(0, 48)}`));
  if (clipped.length) {
    console.log(`  text overflow ${label} @ ${viewport.width}px:\n${clipped.join("\n")}`);
  }
}

async function shoot(page, label, viewport) {
  await page.waitForTimeout(150);           // settle fonts and transitions
  await checkOverflow(page, label, viewport);
  await reportClippedText(page, label, viewport);
  const file = `${label}-${viewport.width}.png`;
  await page.screenshot({ path: `${OUT}${file}` });
  console.log(`  ${file}`);
}

async function withPage(browser, viewport, { seed = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => failures.push(`JS error @ ${viewport.width}px: ${err.message}`));
  if (seed) {
    await context.addInitScript((snapshot) => {
      localStorage.setItem("steam_id", "76561198000000000");
      localStorage.setItem("epic_access_token", "epic-tok");
      localStorage.setItem("view_mode", "list");
      localStorage.setItem("currency", "INR");
      localStorage.setItem("last_scan", JSON.stringify(snapshot));
    }, SNAPSHOT);
  }
  await page.goto(BASE, { waitUntil: "networkidle" });
  return { context, page };
}

mkdirSync(OUT, { recursive: true });
const server = spawn("python3", ["server.py"], {
  env: { ...process.env, PORT },
  stdio: "ignore",
});

try {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n${viewport.width}×${viewport.height}`);

      // The landing page: no credentials, nothing restored.
      {
        const { context, page } = await withPage(browser, viewport);
        await shoot(page, "landing", viewport);
        await context.close();
      }

      // The dashboard, and the two panels that cover it.
      {
        const { context, page } = await withPage(browser, viewport, { seed: true });
        await page.waitForSelector(".game-row", { timeout: 10000 });
        await shoot(page, "dashboard", viewport);

        await page.locator(".game-row").first().click();
        await page.waitForSelector(".drawer-body .drawer-row", { timeout: 5000 });
        await shoot(page, "drawer", viewport);

        await page.locator("#drawer-close").click();
        await page.locator('button[data-action="confirm-forget"]').first().click();
        await page.waitForSelector(".forget-card", { timeout: 5000 });
        await shoot(page, "forget", viewport);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} layout failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("\nno horizontal overflow at any width");
