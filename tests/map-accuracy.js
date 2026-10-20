// Checks that markers on the Full time map sit exactly on their coordinates, at several zoom levels.
// Run with the site served on :8765:  node tests/map-accuracy.js   (needs Playwright)
// For each known place and zoom: MapLibre's own projection of the coordinate vs the centre of the
// marker's dot on screen. They must agree within 1.5 px. Screenshots go to tests/out/.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const BASE = process.env.BASE || "http://127.0.0.1:8765";
(async () => {
  const out = path.join(__dirname, "out"); fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = []; p.on("pageerror", (e) => errors.push(e.message));
  if (process.env.TILES_VIA_CURL) { // the sandbox's browser can't reach the tile server directly
    const { execFileSync } = require("child_process");
    await p.route(/arcgis(online)?\.com/, (r) => r.fulfill({ contentType: "image/jpeg", body: execFileSync("curl", ["-sS", "-m", "20", r.request().url()]) }));
  }
  await p.goto(`${BASE}/tests/map-accuracy.html`);
  await p.waitForFunction(() => window.summary && document.querySelectorAll(".sm-pin").length >= 3, null, { timeout: 30000 });
  let worst = 0, rows = [];
  for (const [name] of Object.entries(await p.evaluate(() => window.PLACES))) {
    for (const zoom of [2, 5, 8, 11]) {
      const r = await p.evaluate(async ([name, zoom]) => {
        const map = window.summary.map, P = window.PLACES[name];
        map.jumpTo({ center: [P.lng, P.lat], zoom });
        await new Promise((res) => map.once("idle", res) || map.triggerRepaint());
        const want = map.project([P.lng, P.lat]);
        const box = map.getContainer().getBoundingClientRect();
        // the dot of the marker nearest to this place
        let best = Infinity;
        for (const dot of document.querySelectorAll(".sm-dot")) {
          const d = dot.getBoundingClientRect();
          const got = { x: d.left + d.width / 2 - box.left, y: d.top + d.height / 2 - box.top };
          best = Math.min(best, Math.hypot(got.x - want.x, got.y - want.y));
        }
        return best;
      }, [name, zoom]);
      worst = Math.max(worst, r);
      rows.push(`${name.padEnd(11)} zoom ${String(zoom).padStart(2)}: marker ${r.toFixed(2)} px from the coordinate`);
      await p.screenshot({ path: path.join(out, `${name}-z${zoom}.png`) });
    }
  }
  console.log(rows.join("\n"));
  console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "no page errors");
  console.log(worst <= 1.5 ? `PASS: every marker within ${worst.toFixed(2)} px` : `FAIL: a marker is ${worst.toFixed(2)} px off`);
  await b.close();
  process.exit(worst <= 1.5 && !errors.length ? 0 : 1);
})();
