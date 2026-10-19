import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const APP = "http://localhost:8000";
fs.mkdirSync("gallery", { recursive: true });
const b = await chromium.launch();
// Devpost thumbnail (3:2)
const t = await b.newPage({ viewport: { width: 1500, height: 1000 } });
await t.goto("file://" + path.resolve("thumbnail.html"), { waitUntil: "networkidle" });
await t.screenshot({ path: "devpost-thumbnail-3x2.png" });
// Gallery: 3:2 screenshots of the key screens
const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const shots = [
  ["01-overview", APP + "/", null],
  ["02-design-lab", APP + "/design", null],
  ["03-passport", APP + "/passport/4", null],
  ["04-greenwashing-rejected", APP + "/passport/2", null],
  ["05-fab-telemetry", APP + "/telemetry", null],
  ["06-ai-compute", APP + "/compute", null],
  ["07-scope3-report", APP + "/report", null],
  ["08-public-verifier", APP + "/verify/4", "read from chain"],
  ["09-website", "file://" + path.resolve("../../site/index.html"), null],
  ["10-website-analysis", "file://" + path.resolve("../../site/analysis.html#a9"), null],
];
for (const [name, url, waitText] of shots) {
  await p.goto(url, { waitUntil: "networkidle" });
  if (waitText) await p.getByText(waitText).waitFor({ timeout: 30000 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `gallery/${name}.png` });
  console.log(name);
}
await b.close();
