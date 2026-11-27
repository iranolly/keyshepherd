// 失败计数会不会自己过期：起真进程 + 假上游，把窗口调成 1.2 秒来测。
// 线上窗口是 1 小时（pool.mjs 里的 FAIL_WINDOW_MS）。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const one = String(detail).split(NL).join(" / ");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${one ? " — " + one : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const upPort = await freePort();
const poolPort = await freePort();

// 假上游：这把钥匙永远 500
const upstream = http.createServer((req, res) => {
  req.resume();
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "boom" }));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keypool-failwin-"));
const cfg = path.join(tmp, "keys.json");
fs.writeFileSync(
  cfg,
  JSON.stringify(
    {
      port: poolPort,
      routes: { "opencode-go": `http://127.0.0.1:${upPort}` },
      queueTimeoutMs: 1500,
      retrySameKeyMs: 0,
      totalTimeoutMs: 6000,
      cooldown: { rateLimitMs: 1000, authErrorMs: 1000, upstreamMs: 1000, maxMs: 60000, jitter: 0 },
      keys: [{ name: "A", key: "key-A", maxConcurrent: 10 }],
    },
    null,
    2,
  ),
);

const base = `http://127.0.0.1:${poolPort}`;
const health = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return r.json();
    } catch {}
    await sleep(100);
  }
  return null;
};
const keyOf = (j) => (j && j.keys && j.keys[0]) || {};

const pool = spawn(process.execPath, [path.join(DIR, "pool.mjs")], {
  env: {
    ...process.env,
    KP_CONFIG: cfg,
    KP_STATE: path.join(tmp, "state.json"),
    KP_LOG: path.join(tmp, "keypool.log"),
    KP_USAGE: path.join(tmp, "usage.json"),
    KP_QUOTA_URL: `http://127.0.0.1:${upPort}/usage-never`,
    KP_FAIL_WINDOW_MS: "1200",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
pool.stderr.on("data", (d) => (stderr += String(d)));
pool.stdout.on("data", () => {});

try {
  upstream.listen(upPort, "127.0.0.1");
  const j0 = await health();
  check("服务起得来", !!j0, j0 ? "" : stderr.slice(-300));
  if (!j0) throw new Error("pool 未启动");

  const r = await fetch(`${base}/opencode-go/x`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m" }),
    signal: AbortSignal.timeout(4000),
  }).catch((e) => ({ status: 0, text: String(e && e.message) }));
  check("坏上游时请求失败", r.status >= 400, `status=${r.status}`);

  let k = keyOf(await health());
  check("失败被记下来了", k.fails >= 1, `fails=${k.fails}`);
  check("同时进了冷却", k.cooldownSeconds > 0 || k.probe === true, `cool=${k.cooldownSeconds} probe=${k.probe}`);

  await sleep(1600); // 越过 1.2 秒的窗口
  k = keyOf(await health());
  check("过了窗口，失败数自己归零", k.fails === 0, `fails=${k.fails}`);
  check("归零后就按满并发用，不再挂着试探", k.cap === 10 && k.probe === false, `cap=${k.cap} probe=${k.probe}`);
} catch (err) {
  check("测试过程没抛异常", false, String(err && err.message));
} finally {
  pool.kill();
  upstream.close();
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：" + failed.map((f) => f.name + (f.detail ? ` (${String(f.detail).split(NL).join(" / ")})` : "")).join("；"));
  process.exitCode = 1;
}
