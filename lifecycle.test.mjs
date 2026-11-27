// 中转生命周期的回归测试：不碰线上 keys.json / state.json / 日志 / 用量。
// 起一个假上游，覆盖 正常 / 流式 / 超大包 / 流中断 / 上游卡住 五个场景，
// 每个场景都要满足三件事：客户端不会永远挂着；并发槽位回到 0；该冷却的钥匙真的冷却。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
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

/* ---------- 假上游 ---------- */
function fakeUpstream(port) {
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    req.resume();
    if (p === "/t/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 3, output_tokens: 5 } }));
      return;
    }
    if (p === "/t/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"a"}\n\n');
      setTimeout(() => {
        res.write('data: {"delta":"b"}\n\n');
        res.end("data: [DONE]\n\n");
      }, 50);
      return;
    }
    if (p === "/t/big") {
      const big = "x".repeat(9 * 1024 * 1024);
      res.writeHead(200, { "content-type": "application/json", "content-length": String(big.length) });
      res.end(big);
      return;
    }
    if (p === "/t/timing") {
      // opencode 真实响应会带这个头：gateway=它家网关排队，upstream=模型出字
      res.writeHead(200, {
        "content-type": "application/json",
        "server-timing": "gateway;dur=1204, upstream;dur=8302, total;dur=9506",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (p === "/t/stream-open") {
      // 发了 [DONE] 却不挂断：opencode 常见，客户端拿到就自己关
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"a"}\n\ndata: [DONE]\n\n');
      return;
    }
    if (p === "/t/timed") {
      // 头发出去了，然后一直吐心跳、永远不结束：模拟上游网关吊着不给结果
      res.writeHead(200, { "content-type": "text/event-stream" });
      const tick = setInterval(() => {
        try {
          res.write('data: {"d":1}\n\n');
        } catch {}
      }, 300);
      res.on("close", () => clearInterval(tick));
      return;
    }
    if (p === "/t/hang") {
      // 头发出去了，正文一个字节都不发
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      return;
    }
    if (p === "/t/break") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"partial"}\n\n');
      setTimeout(() => res.socket.destroy(), 60);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/* ---------- 工具 ---------- */
async function waitHealth(base, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

async function health(base) {
  const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

async function activeSum(base) {
  const j = await health(base);
  return j.keys.reduce((a, k) => a + (k.active || 0), 0);
}

async function coolingCount(base) {
  const j = await health(base);
  return j.keys.filter((k) => k.cooldownSeconds > 0).length;
}

async function post(base, p, body) {
  const started = Date.now();
  try {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "lifecycle-" + p.replace(/\W/g, "") },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    return { ms: Date.now() - started, status: r.status, text };
  } catch (err) {
    return { ms: Date.now() - started, status: 0, text: "", error: String(err && err.message) };
  }
}

/* ---------- 主流程 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keypool-life-"));
const readLog = () => {
  try {
    return fs.readFileSync(path.join(tmp, "keypool.log"), "utf8");
  } catch {
    return "";
  }
};
const upPort = await freePort();
const poolPort = await freePort();
const upstream = await fakeUpstream(upPort);

const cfgPath = path.join(tmp, "keys.json");
fs.writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      port: poolPort,
      routes: { "opencode-go": `http://127.0.0.1:${upPort}` },
      queueTimeoutMs: 4000,
      queueOnCooldownMs: 1000,
      retrySameKeyMs: 0,
      streamIdleTimeoutMs: 2500,
      totalTimeoutMs: 6000,
      keys: [
        { name: "T1", key: "test-key-1", maxConcurrent: 4 },
        { name: "T2", key: "test-key-2", maxConcurrent: 4 },
      ],
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, [path.join(DIR, "pool.mjs")], {
  env: {
    ...process.env,
    KP_CONFIG: cfgPath,
    KP_STATE: path.join(tmp, "state.json"),
    KP_LOG: path.join(tmp, "keypool.log"),
    KP_USAGE: path.join(tmp, "usage.json"),
    KP_QUOTA_URL: `http://127.0.0.1:${upPort}/usage-never`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += String(d)));
child.stdout.on("data", () => {});

const base = `http://127.0.0.1:${poolPort}`;
try {
  const up = await waitHealth(base);
  check("服务起得来", up, up ? "" : "health 一直不 OK：" + stderr.slice(-300));
  if (!up) throw new Error("pool 未启动");

  // 1. 普通整包
  const ok = await post(base, "/opencode-go/t/ok", JSON.stringify({ model: "m", input: "hi" }));
  check("整包转发 200", ok.status === 200, `status=${ok.status} ms=${ok.ms}`);
  await sleep(300);
  check("整包后槽位归零", (await activeSum(base)) === 0);

  // 2. 流式正常结束
  const st = await post(base, "/opencode-go/t/stream", JSON.stringify({ model: "m", input: "hi", stream: true }));
  check("流式收到结束标记", st.text.includes("[DONE]"), `status=${st.status} ms=${st.ms} len=${st.text.length}`);
  await sleep(300);
  check("流式后槽位归零", (await activeSum(base)) === 0);

  // 3. 超大包：必须快速报错，不能挂着，也不该把钥匙打冷却（不是上游的错）
  const big = await post(base, "/opencode-go/t/big", JSON.stringify({ model: "m", input: "hi" }));
  check("超 8MB 不挂死", big.status !== 0 && big.ms < 14000, `status=${big.status} ms=${big.ms}`);
  await sleep(300);
  check("超大包后槽位归零", (await activeSum(base)) === 0);
  check("超大包不冷却钥匙", (await coolingCount(base)) === 0);

  // 4. 流式传到一半上游断掉：客户端必须收到终止信号，而不是空等
  const brk = await post(base, "/opencode-go/t/break", JSON.stringify({ model: "m", input: "hi", stream: true }));
  check("流中断后客户端能被结束", brk.ms < 14000, `status=${brk.status} ms=${brk.ms} err=${brk.error || ""}`);
  await sleep(500);
  check("流中断后槽位归零", (await activeSum(base)) === 0);

  // 5. opencode 自报的网关/模型耗时必须落到日志里（归因靠它）
  const tm = await post(base, "/opencode-go/t/timing", JSON.stringify({ model: "m", input: "hi" }));
  await sleep(300);
  check(
    "日志记下网关/模型耗时",
    / gw=\d+ up=\d+/.test(readLog()),
    (readLog().split("\n").filter((l) => l.includes("OK key=")).pop() || "").slice(0, 160),
  );
  check("带 server-timing 的请求也返回 200", tm.status === 200, `status=${tm.status}`);

  // 6. 上游答应却永远不结束：总时限到点要收尾，不能把槽位吊死
  const beforeTimed = await health(base);
  const beforeFails = Object.fromEntries(beforeTimed.keys.map((k) => [k.name, k.fails]));
  const td = await post(base, "/opencode-go/t/timed", JSON.stringify({ model: "m", input: "hi", stream: true }));
  check("总时限到点能收尾", td.status === 504 || (td.status === 0 && td.ms < 14000), `status=${td.status} ms=${td.ms} err=${td.error || ""}`);
  await sleep(400);
  check("总时限后槽位归零", (await activeSum(base)) === 0);
  check("日志记下 TIMEOUT", /TIMEOUT .*after=\d+s/.test(readLog()));

  // 总时限是我们自己提断的：不能把接这个请求的钥匙记成故障
  // （以前就是这样把钥匙打进半开，接着整池卡住）
  const afterTimeout = await health(base);
  const timedLines = readLog().split("\n").filter((l) => l.includes("TIMEOUT") && l.includes("key="));
  const timedKey = (timedLines.pop() || "").split("key=").pop().split(" ")[0];
  const afterKey = afterTimeout.keys.find((k) => k.name === timedKey) || {};
  check(
    "总时限不记成钥匙失败",
    !!afterKey.name && afterKey.fails === beforeFails[timedKey] && afterKey.cooldownSeconds === 0,
    `key=${timedKey || "?"} fails ${beforeFails[timedKey]}→${afterKey.fails} cool=${afterKey.cooldownSeconds}`,
  );

  // 7. 客户端先跑（pi 的 300 秒上限）：以前这里一片空白，现在要留痕
  const ac = new AbortController();
  const inflight = fetch(base + "/opencode-go/t/timed", {
    method: "POST",
    headers: { "content-type": "application/json", session_id: "abort-case" },
    body: JSON.stringify({ model: "m", input: "hi", stream: true }),
    signal: ac.signal,
  }).catch(() => {});
  await sleep(800);
  ac.abort();
  await inflight;
  await sleep(500);
  check("客户端提前断开有记录", /CLIENT-ABORT key=/.test(readLog()));
  check("客户端断开后槽位归零", (await activeSum(base)) === 0);

  // 拿到 [DONE] 后客户端正常关连接，不能记成“中途跑掉”
  const abortsBefore = (readLog().match(/CLIENT-ABORT/g) || []).length;
  const okBefore = (readLog().match(/ \(client-close\)/g) || []).length;
  const ac2 = new AbortController();
  const doneFirst = fetch(base + "/opencode-go/t/stream-open", {
    method: "POST",
    headers: { "content-type": "application/json", session_id: "done-case" },
    body: JSON.stringify({ model: "m", input: "hi", stream: true }),
    signal: ac2.signal,
  }).catch(() => {});
  await sleep(600);
  ac2.abort();
  await doneFirst;
  await sleep(400);
  check(
    "拿到 [DONE] 后关连接不算中断",
    (readLog().match(/CLIENT-ABORT/g) || []).length === abortsBefore,
    `before=${abortsBefore} after=${(readLog().match(/CLIENT-ABORT/g) || []).length}`,
  );
  check(
    "拿到 [DONE] 后关连接仍然记一行 OK",
    (readLog().match(/ \(client-close\)/g) || []).length > okBefore,
    `before=${okBefore} after=${(readLog().match(/ \(client-close\)/g) || []).length}`,
  );

  // 8. 上游拿到头之后不动：空闲超时打断 + 换钥匙 + 这把钥匙进冷却
  const hang = await post(base, "/opencode-go/t/hang", JSON.stringify({ model: "m", input: "hi" }));
  check("上游卡住会被超时打断", hang.status !== 0 && hang.ms < 14000, `status=${hang.status} ms=${hang.ms}`);
  await sleep(300);
  check("卡住后槽位归零", (await activeSum(base)) === 0);
  check("卡住的钥匙进了冷却", (await coolingCount(base)) >= 1, `cooling=${await coolingCount(base)}`);
} catch (err) {
  check("测试执行", false, String(err && err.message));
} finally {
  try {
    child.kill();
  } catch {}
  upstream.close();
  await sleep(200);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
