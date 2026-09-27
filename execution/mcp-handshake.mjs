/**
 * mcp-handshake.mjs — prove the tradingview-mcp server actually answers.
 *
 * The server is installed globally, so its path depends on the machine. Resolve
 * it from `npm root -g` rather than hardcoding one; a hardcoded path makes this
 * script — and the README setup prompt that calls it — fail on every other box.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveServer() {
  const fromEnv = process.env.TRADINGVIEW_MCP_SERVER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  let root;
  try {
    // No args array, and shell:true, because on Windows the binary is npm.cmd:
    // patched Node refuses to spawn a .cmd without a shell, and passing args
    // alongside shell:true trips DEP0190.
    root = execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(`could not run \`npm root -g\`: ${e.message}`);
  }
  const p = join(root, "tradingview-mcp", "src", "server.js");
  if (!existsSync(p)) {
    throw new Error(
      `tradingview-mcp is not installed globally (looked for ${p}).\n` +
      `Install it with:  npm i -g tradingview-mcp@1.0.1`
    );
  }
  return p;
}

let SERVER;
try {
  SERVER = resolveServer();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.log("server:  " + SERVER + "\n");

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* not JSON-RPC line */ }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d.toString()));

let id = 0;
const send = (method, params) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
});
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "probe", version: "1.0.0" },
});
console.log("initialize  ->", JSON.stringify(init.result?.serverInfo));

notify("notifications/initialized");

const tools = await send("tools/list", {});
const list = tools.result?.tools || [];
console.log("tools/list  -> " + list.length + " tools");

const want = ["tv_health_check", "chart_get_state", "quote_get", "data_get_ohlcv",
  "capture_screenshot", "replay_trade", "pine_smart_compile", "batch_run"];
console.log("\nkey tools present:");
for (const w of want) {
  const hit = list.find((t) => t.name === w);
  console.log(`  ${hit ? "YES" : "no "}  ${w}`);
}

const hc = list.find((t) => t.name === "tv_health_check");
if (hc) console.log("\ntv_health_check schema:", JSON.stringify(hc.inputSchema));

child.kill();
process.exit(0);
