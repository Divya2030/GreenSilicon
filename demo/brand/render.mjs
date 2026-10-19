import { chromium } from "playwright";
import path from "node:path";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto("file://" + path.resolve("thumbnail.html"), { waitUntil: "networkidle" });
await p.screenshot({ path: "youtube-thumbnail.png" });
for (const size of [512, 1024]) {
  const q = await b.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: size / 512 });
  await q.goto("file://" + path.resolve("logo.svg"));
  await q.screenshot({ path: `logo-${size}.png`, omitBackground: true });
}
await b.close();
