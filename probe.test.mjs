// 半开（试探）生命周期的回归测试：起真进程 + 假上游，不碰线上 keys.json / state.json。
//
// 要锁住四件事（2026-11-26 那次全池卡死就是它们出了错）：
//   1. 试探只放一个位；
//   2. 迟迟没有回声（probeMaxMs）就放宽到 3 个位，别让一个请求占死整池；
//   3. 拿到 2xx 立刻恢复满速（不是等流式请求跑完，那可能要几分钟）；
//   4. 只剩一把能接活的钥匙时不试探，直接按正常并发用。
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
  const oneLine = String(detail).split(NL).join(" / ");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${oneLine ? " — " + oneLine : ""}`);
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

/* ---------- 假上游：按钥匙（Bearer）和路径决定表现 ---------- */
function fakeUpstream(port) {
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    const q = new URL(req.url, "http://x").searchParams;
    const who = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    req.resume();
    const json = (code, obj, extra = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(obj));
    };

    if (p === "/t/fail") {
      // A 总是坏，B 永远好：用来把 A 打进冷却再半开
      if (who === "key-A") return json(500, { error: "boom" });
      return json(200, { ok: true });
    }
    if (p === "/t/rate-b") {
      if (who === "key-B") return json(429, { error: "rate" }, { "retry-after": "30" });
      return json(200, { ok: true });
    }
    if (p === "/t/slow") {
      const ms = Math.max(100, Number(q.get("ms")) || 1200);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"a"}' + NL + NL);
      const t = setTimeout(() => {
        try {
          res.end("data: [DONE]" + NL + NL);
        } catch {}
      }, ms);
      res.on("close", () => clearTimeout(t));
      return;
    }
    if (p === "/t/late") {
      // 先憋着不发响应头（试探就是在这种“没回声”的情况下被卡住的），
      // 到点只发响应头 + 一帧，然后继续挂住：用来证明“响应头一到就放开”，不是等流跑完
      const ms = Math.max(100, Number(q.get("ms")) || 1500);
      const hold = Math.max(100, Number(q.get("hold")) || 4000);
      const t = setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"delta":"a"}' + NL + NL);
          const t2 = setTimeout(() => {
            try {
              res.end("data: [DONE]" + NL + NL);
            } catch {}
          }, hold);
          res.on("close", () => clearTimeout(t2));
        } catch {}
      }, ms);
      res.on("close", () => clearTimeout(t));
      return;
    }
    if (p === "/t/ok") return json(200, { ok: true, usage: { input_tokens: 1, output_tokens: 1 } });
    return json(404, {});
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/* ---------- 工具 ---------- */
async function health(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return r.json();
    } catch {}
    await sleep(100);
  }
  return null;
}
const keyOf = (j, name) => (j ? j.keys.find((k) => k.name === name) : null) || {};

function post(base, p, ck, ms = 20000) {
  return (async () => {
    try {
      const r = await fetch(base + p, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", prompt_cache_key: ck }),
        signal: AbortSignal.timeout(ms),
      });
      const text = await r.text();
      return { status: r.status, text };
    } catch (err) {
      return { status: 0, text: "", error: String(err && err.message) };
    }
  })();
}

/* ---------- 起服务 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keypool-probe-"));
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
      queueTimeoutMs: 3000,
      queueOnCooldownMs: 50,
      retrySameKeyMs: 0,
      streamIdleTimeoutMs: 12000,
      totalTimeoutMs: 15000,
      probeMaxMs: 700,
      cooldown: { rateLimitMs: 3000, authErrorMs: 3000, upstreamMs: 300, maxMs: 60000, jitter: 0 },
      keys: [
        { name: "A", key: "key-A", maxConcurrent: 10 },
        { name: "B", key: "key-B", maxConcurrent: 10 },
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
const readLog = () => {
  try {
    return fs.readFileSync(path.join(tmp, "keypool.log"), "utf8");
  } catch {
    return "";
  }
};

const base = `http://127.0.0.1:${poolPort}`;
const pending = [];
try {
  const first = await health(base);
  check("服务起得来", !!first, first ? "" : "health 一直不 OK：" + stderr.slice(-300));
  if (!first) throw new Error("pool 未启动");

  /* ---------- 1. 把 A 打成半开 ---------- */
  const bad = await post(base, "/opencode-go/t/fail", "f1");
  check("坏钥匙失败后换到好的那把", bad.status === 200, `status=${bad.status}`);
  await sleep(1200); // 冷却有 1 秒下限（cooldownMs 里的 Math.max(1000, …)）
  let A = keyOf(await health(base), "A");
  check("A 冷却过了、进入半开", A.fails > 0 && A.cooldownSeconds === 0, `fails=${A.fails} cool=${A.cooldownSeconds}`);

  /* ---------- 2. 把 B 填满到评分高于 A，让试探请求落到 A ---------- */
  // 每条都带不同的 prompt_cache_key：否则会话粘住会把新请求也钉在 B 上，测不到“该轮到 A”
  for (let i = 0; i < 5; i++) pending.push(post(base, "/opencode-go/t/slow?ms=2600", "s" + i));
  await sleep(150);
  let j = await health(base);
  A = keyOf(j, "A");
  check("五个长请求都在 B 上", keyOf(j, "B").active === 5, `B.active=${keyOf(j, "B").active} A.active=${A.active}`);
  check("A 还在半开、此时还没被选", A.probe === true && A.active === 0, `probe=${A.probe} active=${A.active}`);

  /* ---------- 3. 第六个请求（不发响应头）落到 A：只放 1 个位 ---------- */
  const late = post(base, "/opencode-go/t/late?ms=1600", "s6");
  pending.push(late);
  await sleep(250);
  j = await health(base);
  A = keyOf(j, "A");
  check("试探只放 1 个位", A.probe === true && A.cap === 1 && A.active === 1, `probe=${A.probe} cap=${A.cap} active=${A.active}`);

  pending.push(post(base, "/opencode-go/t/slow?ms=300", "s7"));
  await sleep(200);
  j = await health(base);
  A = keyOf(j, "A");
  check("位子占满后不再往 A 塞", A.active === 1 && A.cap === 1, `active=${A.active} cap=${A.cap}`);

  /* ---------- 4. 迟迟没有回声：放宽到 3 个位（不清失败数） ---------- */
  await sleep(500); // 从入席算起累计 > probeMaxMs 700
  j = await health(base);
  A = keyOf(j, "A");
  check("试探超时后放宽到 3 个位", A.cap === 3, `cap=${A.cap}`);
  check("放宽不等于当作成功", A.probe === true && A.fails > 0, `probe=${A.probe} fails=${A.fails}`);
  check("日志留下放宽痕迹", /PROBE-RAMP key=A/.test(readLog()));

  /* ---------- 5. 放宽后能真的多接活 ---------- */
  for (let i = 0; i < 2; i++) pending.push(post(base, "/opencode-go/t/slow?ms=2500", "s" + (8 + i)));
  await sleep(250);
  A = keyOf(await health(base), "A");
  check("放宽后 A 能接 2 个以上", A.active >= 2, `active=${A.active} cap=${A.cap} probe=${A.probe}`);

  /* ---------- 6. 响应头一到就放开，不等流跑完 ----------
     关键断言：这一刻 A 上还有 3 条流在跑（试探那条 + 两条长的），一条都还没结束，
     所以 probe=false 只可能来自“拿到 2xx 响应头”，不可能是“流跑完时的成功回调”。 */
  await sleep(700); // late 在入席后 1600ms 才发响应头
  j = await health(base);
  A = keyOf(j, "A");
  check(
    "响应头一到就恢复满速（流还在跑）",
    A.probe === false && A.cap === 10 && A.fails === 0 && A.active >= 1,
    `probe=${A.probe} cap=${A.cap} fails=${A.fails} active=${A.active}`,
  );
  check("日志留下恢复痕迹", /PROBE-OPEN key=A/.test(readLog()));

  /* ---------- 7. 只剩一把能接活时：不试探，按正常并发用 ---------- */
  await Promise.allSettled(pending.splice(0));
  await sleep(200);

  const failAgain = await post(base, "/opencode-go/t/fail", "f2"); // A 再坏一次 → 冷却 1 秒
  check("第二次失败仍然能靠 B 完成", failAgain.status === 200, `status=${failAgain.status}`);
  const rateB = await post(base, "/opencode-go/t/rate-b", "rb"); // A 还在冷却，轮到 B 吃 429 → 冷却 3 秒
  check("B 被限流后客户端拿到 429", rateB.status === 429, `status=${rateB.status}`);
  await sleep(1100); // A 的 1 秒冷却已过，B 还差得远

  j = await health(base);
  A = keyOf(j, "A");
  check("只剩 A 能接活时不试探", A.probe === false && A.cap === 10, `probe=${A.probe} cap=${A.cap}`);
  check("A 仍是半开（失败数没被清）", A.fails > 0 && A.cooldownSeconds === 0, `fails=${A.fails} cool=${A.cooldownSeconds}`);
  const last = await post(base, "/opencode-go/t/ok", "ok1");
  check("唯一一把钥匙能正常干活", last.status === 200, `status=${last.status}`);

/* ---------- 8. 真没空位时：报错要写清每把钥匙的状态，不能只说“并发已满” ---------- */
const busyPend = [];
let pool2 = null;
try {
  const pool2Port = await freePort();
  const cfg2 = path.join(tmp, "keys-busy.json");
  fs.writeFileSync(
    cfg2,
    JSON.stringify(
      {
        port: pool2Port,
        routes: { "opencode-go": `http://127.0.0.1:${upPort}` },
        queueTimeoutMs: 1000, // 配置里 1000 是下限
        retrySameKeyMs: 0,
        totalTimeoutMs: 15000,
        keys: [
          { name: "P1", key: "key-A", maxConcurrent: 1 },
          { name: "P2", key: "key-B", maxConcurrent: 1 },
        ],
      },
      null,
      2,
    ),
  );
  pool2 = spawn(process.execPath, [path.join(DIR, "pool.mjs")], {
    env: {
      ...process.env,
      KP_CONFIG: cfg2,
      KP_STATE: path.join(tmp, "state-busy.json"),
      KP_LOG: path.join(tmp, "keypool-busy.log"),
      KP_USAGE: path.join(tmp, "usage-busy.json"),
      KP_QUOTA_URL: `http://127.0.0.1:${upPort}/usage-never`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pool2.stderr.on("data", () => {});
  const base2 = `http://127.0.0.1:${pool2Port}`;
  const up2 = await health(base2);
  check("第二个池子起得来", !!up2);
  busyPend.push(post(base2, "/opencode-go/t/slow?ms=2500", "b1"));
  busyPend.push(post(base2, "/opencode-go/t/slow?ms=2500", "b2"));
  await sleep(250);
  const third = await post(base2, "/opencode-go/t/slow?ms=500", "b3");
  let body = {};
  try {
    body = JSON.parse(third.text);
  } catch {}
  check("没空位时回 503", third.status === 503, `status=${third.status}`);
  check("报错写清是满员", /满员 1\/1/.test(String(body.error)), String(body.error));
  check("报错点名每把钥匙", Array.isArray(body.keys) && body.keys.length === 2, `keys=${JSON.stringify(body.keys)}`);
  check("报错不再是那句误导的“并发额度已满”", !/并发额度已满/.test(String(body.error)), String(body.error));
} catch (err) {
  check("报错场景没抛异常", false, String(err && err.message));
} finally {
  await Promise.allSettled(busyPend);
  if (pool2) pool2.kill();
}
} catch (err) {
  check("测试过程没抛异常", false, String(err && err.message));
} finally {
  await Promise.allSettled(pending);
  child.kill();
  upstream.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：" + failed.map((f) => f.name + (f.detail ? ` (${String(f.detail).split(NL).join(" / ")})` : "")).join("；"));
  process.exitCode = 1;
}
