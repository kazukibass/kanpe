import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

const html = await readFile(new URL("../index.html", import.meta.url));
const cues = [
  { at: 0, text: "01 開始\n本文" },
  { at: 60, text: "02 説明\n本文" },
  { at: 120, text: "終了" },
];

async function assertTimelineFits(page, checkLabels = true) {
  const geometry = await page.evaluate(() => {
    const rect = element => {
      const { left, right, width } = element.getBoundingClientRect();
      return { left, right, width };
    };
    const ticks = [...document.querySelectorAll("#ribbon .tick")].map(rect);
    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      ribbon: rect(document.getElementById("ribbon")),
      labels: rect(document.getElementById("cueLabels")),
      ticks,
    };
  });
  assert.equal(geometry.ticks.length, 3);
  assert.equal(geometry.ticks[0].width, 44);
  assert.equal(geometry.ticks[2].width, 44);
  assert.ok(geometry.ticks[0].left >= 0, "start hit area escapes viewport");
  assert.ok(geometry.ticks[2].right <= geometry.width, "end hit area escapes viewport");
  assert.equal(geometry.scrollWidth, geometry.width, "document overflows horizontally");
  if (checkLabels) {
    assert.equal(geometry.labels.left, geometry.ribbon.left);
    assert.equal(geometry.labels.right, geometry.ribbon.right);
  }
}

test("desktop timeline endpoints fit inside viewport and remain operable", { timeout: 60_000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1024, 1280, 1440, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        // Standalone HTML is a supported use case; no network access to shared LP assets.
        await context.route("https://**/*", route => route.abort());
        await context.addInitScript(items => {
          localStorage.setItem("kanpe.v1", JSON.stringify({
            title: "layout regression", cues: items, scale: 1, theme: "dark",
            target: 0, rate: 300,
          }));
        }, cues);
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
        await page.locator("#ribbon .tick").last().waitFor();
        await assertTimelineFits(page);
        await page.locator("#ribbon .tick").last().click();
        assert.equal(await page.locator("#clock").textContent(), "02:00");
        await page.locator("#ribbon .tick").first().click();
        assert.equal(await page.locator("#clock").textContent(), "00:00");
        await page.locator("#fullEditBtn").click();
        assert.ok(await page.locator("#editView").isVisible());
        await assertTimelineFits(page);
        await page.locator("#brandBtn").click();
        await page.locator("#focusBtn").click();
        assert.ok(await page.locator("body").evaluate(el => el.classList.contains("focus")));
        await assertTimelineFits(page, false);
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("kanpe.v1")).cues), cues);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
