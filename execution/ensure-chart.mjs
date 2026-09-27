import CDP from "file:///C:/Users/ez/AppData/Roaming/npm/node_modules/tradingview-mcp/node_modules/chrome-remote-interface/index.js";

const SYMBOL = (process.argv[2] || "BTCUSD").toUpperCase();
const CDP_URL = "http://localhost:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP_URL}/json/list`)).json();
const pages = list.filter((t) => t.type === "page");

const isChart = (t) => /tradingview\.com\/chart/i.test(t.url);
const existing = pages.find(isChart);

if (existing) {
  console.log(`chart already open: ${existing.title}`);
  console.log(`url: ${existing.url}`);
  process.exit(0);
}

console.log("no chart target found - opening one");

// Prefer recycling a dead error-view tab, then a new-tab page.
const host =
  pages.find((t) => /error-view\/index\.html/i.test(t.url)) ||
  pages.find((t) => /new-tab\/index\.html/i.test(t.url)) ||
  pages.find((t) => t.url.startsWith("file://") && !/tooltip|browser-api|drag-service/.test(t.url));

if (!host) {
  console.error("no suitable host tab to repurpose");
  process.exit(1);
}

console.log(`repurposing: ${host.url.slice(0, 80)}`);

const client = await CDP({ host: "localhost", port: 9222, target: host.id });
const { Page } = client;
await Page.enable();

const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(SYMBOL)}`;
await Page.navigate({ url });
console.log(`navigated -> ${url}`);

for (let i = 0; i < 20; i++) {
  await sleep(1500);
  const after = await (await fetch(`${CDP_URL}/json/list`)).json();
  const chart = after.find(isChart);
  if (chart) {
    console.log(`\nOK chart target ready after ~${(i + 1) * 1.5}s`);
    console.log(`title: ${chart.title}`);
    console.log(`url:   ${chart.url}`);
    await client.close();
    process.exit(0);
  }
}

console.error("timed out waiting for chart target");
await client.close();
process.exit(1);
