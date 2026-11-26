import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

const html = new Map([
  ["/home.html", await readFile(new URL("../home.html", import.meta.url))],
  ["/index.html", await readFile(new URL("../index.html", import.meta.url))],
]);

// Synthetic payloads generated 2026-11-26 with Trace Memo main
// 979fec2be5b211b892bf98b9ad1d24c7942b60c4:
// serializeMemoTable -> parseMemoTable -> makeKanpePayload.
// Canonical: arbitrary "補足"/"時刻"/"台本" columns, fullwidth ０：００,
// 1分30秒, blank mapped row, bare 2 (minutes), 151秒.
// Normalization: 0:00 and 1:00:01, text with fullwidth punctuation,
// ideographic spaces, CRLF, and leading/trailing spaces.
// Kept as a static contract fixture; no cross-repository access in CI.
const tracePayloads = [
  {
    "title": "合成・Trace Memo → Kanpe",
    "cues": [
      {
        "at": 0,
        "text": "01 開会\n本日は「発表」です。"
      },
      {
        "at": 90,
        "text": "02 説明\n記号 | \\ と \"引用\" を含む。"
      },
      {
        "at": 120,
        "text": "03 資料\n日本語と\n改行 😀"
      },
      {
        "at": 151,
        "text": "終了"
      }
    ]
  },
  {
    "title": "合成・正規化の境界",
    "cues": [
      {
        "at": 0,
        "text": " ０１：開始\r\n本文　です。 "
      },
      {
        "at": 3601,
        "text": "終了"
      }
    ]
  }
];

async function downloadJson(page, button) {
  const ready = page.waitForEvent("download");
  await button.click();
  const download = await ready;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("Trace Memo native JSON imports through paste/file, exports and opens in Kanpe", { timeout: 60_000 }, async () => {
  const server = createServer((request, response) => {
    if (!html.has(request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html.get(request.url));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [caseIndex, input] of tracePayloads.entries()) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
      });
      try {
        // Exercise only standalone checked-in HTML, not external shared shell.
        await context.route("https://**/*", route => route.abort());
        const page = await context.newPage();
        await page.goto(base + "/home.html");

        // Both routes exercise the production dialog and actual import handler.
        const raw = JSON.stringify(input);
        await page.locator("#importBtn").click();
        if (caseIndex === 0) {
          await page.locator("#impText").fill(raw);
        } else {
          await page.locator("#file").setInputFiles({
            name: "trace-memo.json",
            mimeType: "application/json",
            buffer: Buffer.from(raw),
          });
          await page.waitForFunction(text => document.getElementById("impText").value === text, raw);
        }
        assert.equal(await page.locator("#impTarget").inputValue(), "new");
        await page.locator("#impRun").click();
        await page.locator(".card-title").filter({ hasText: input.title }).waitFor();

        const expected = caseIndex === 0 ? input : {
          title: input.title,
          // Kanpe's EXISTING JSON importer normalizes text. Numeric at values stay seconds.
          cues: [{ at: 0, text: "01:開始\n本文 です。" }, { at: 3601, text: "終了" }],
        };
        const library = await page.evaluate(() => JSON.parse(localStorage.getItem("kanpe.v2")));
        assert.equal(library.scripts.length, 1);
        assert.deepEqual({ title: library.scripts[0].title, cues: library.scripts[0].cues }, expected);
        assert.match(library.scripts[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

        // Reload home to prove persisted result, then download from actual output UI.
        await page.reload();
        const card = page.locator(".card");
        assert.equal(await card.count(), 1);
        assert.equal(await card.locator(".card-title").textContent(), expected.title);
        await card.getByRole("button", { name: "出力", exact: true }).click();
        const output = await downloadJson(page, page.locator("#outJsonBtn"));
        assert.deepEqual(output, expected);
        await page.locator("#outClose").click();
        await Promise.all([
          page.waitForURL(base + "/index.html"),
          card.getByRole("button", { name: "開く", exact: true }).click(),
        ]);
        await page.locator("#ribbon .tick").last().waitFor();
        assert.equal(await page.locator("#ribbon .tick").count(), expected.cues.length);
        const opened = await page.evaluate(() => JSON.parse(localStorage.getItem("kanpe.v1")));
        assert.deepEqual({ title: opened.title, cues: opened.cues }, expected);
        await page.locator("#ribbon .tick").last().click();
        const finalAt = expected.cues.at(-1).at;
        const endLabel = String(Math.floor(finalAt / 60)).padStart(2, "0") + ":" + String(finalAt % 60).padStart(2, "0");
        assert.equal(await page.locator("#clock").textContent(), endLabel);
        console.log(`PASS ${caseIndex === 0 ? "paste" : "file"}: ${expected.cues.length} cues persisted, downloaded, and opened at ${endLabel}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
