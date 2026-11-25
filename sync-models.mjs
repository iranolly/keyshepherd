// 把 pi 自己的 opencode-go 模型目录同步成 keypool 的模型清单
// 数据源：https://pi.dev/api/models/providers/opencode-go（与 pi 内置目录同一份，可由 pi update --models 刷新）
// 用法：node sync-models.mjs [--dry]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEYS_PATH = path.join(DIR, "keys.json");
const MODELS_PATH = path.join(DIR, "..", "models.json");
const CATALOG_URL = "https://pi.dev/api/models/providers/opencode-go";
const KEEP_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const dry = process.argv.includes("--dry");

// 手工钉住的字段：目录里的值会被这些覆盖（保留你自己调过的上限）
const PINNED = {
  "deepseek-v4.1-flash": { contextWindow: 400000 },
};

const keys = JSON.parse(fs.readFileSync(KEYS_PATH, "utf8"));
const port = keys.port || 18787;
const proxyBase = `http://127.0.0.1:${port}`;

function rewriteBaseUrl(upstream) {
  const raw = String(upstream || "https://opencode.ai/inference/go");
  const marker = "https://opencode.ai/inference/go";
  const rest = raw.startsWith(marker) ? raw.slice(marker.length) : "";
  return `${proxyBase}/opencode-go${rest}`;
}

function toModelEntry(m) {
  const out = {
    id: m.id,
    name: m.name || m.id,
    api: m.api,
    reasoning: !!m.reasoning,
    input: Array.isArray(m.input) && m.input.length ? m.input : ["text"],
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    baseUrl: rewriteBaseUrl(m.baseUrl),
  };
  Object.assign(out, PINNED[m.id] || {});
  for (const key of ["compat", "thinkingLevelMap", "inputLimits", "samplingParams", "promptCache", "headers"]) {
    if (m[key] && (typeof m[key] !== "object" || Object.keys(m[key]).length)) out[key] = m[key];
  }
  return out;
}

const res = await fetch(CATALOG_URL, { headers: { accept: "application/json" } });
if (!res.ok) {
  console.error(`目录请求失败：HTTP ${res.status}`);
  process.exit(1);
}
const catalog = await res.json();
const models = Object.values(catalog || {})
  .filter((m) => m && m.type === "chat" && KEEP_APIS.has(m.api) && m.id)
  .map(toModelEntry)
  .sort((a, b) => a.id.localeCompare(b.id));

if (!models.length) {
  console.error("目录里没有可用的对话模型，未改动");
  process.exit(1);
}

const modelsJson = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"));
modelsJson.providers = modelsJson.providers || {};
const prev = modelsJson.providers["opencode-pool"] || {};
const provider = {
  name: prev.name || "OpenCode Go (key pool)",
  baseUrl: `${proxyBase}/opencode-go/openai/v1`,
  api: "openai-completions",
  apiKey: prev.apiKey || "keypool",
  models,
};
if (prev.headers) provider.headers = prev.headers;

const added = models.filter((m) => !(prev.models || []).some((p) => p.id === m.id)).map((m) => m.id);
const removed = (prev.models || []).filter((p) => !models.some((m) => m.id === p.id)).map((p) => p.id);

console.log(`目录：${models.length} 个对话模型（openai=${models.filter((m) => m.api.startsWith("openai")).length}、anthropic=${models.filter((m) => m.api === "anthropic-messages").length}、google=${models.filter((m) => m.api === "google-generative-ai").length}）`);
if (added.length) console.log(`新增：${added.join(", ")}`);
if (removed.length) console.log(`移除：${removed.join(", ")}`);

const same = JSON.stringify(prev.models || []) === JSON.stringify(models);
if (same) {
  console.log(`无需更新（${new Date().toISOString()}）`);
} else if (dry) {
  console.log("--dry：有变化，未写入");
} else {
  const backup = `${MODELS_PATH}.bak-${new Date().toISOString().slice(0, 10)}-modelsync`;
  fs.copyFileSync(MODELS_PATH, backup);
  modelsJson.providers["opencode-pool"] = provider;
  const tmp = `${MODELS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(modelsJson, null, 2) + String.fromCharCode(10), "utf8");
  fs.renameSync(tmp, MODELS_PATH);
  console.log(`已写入 ${MODELS_PATH}（备份 ${path.basename(backup)}）`);
  console.log("新开会话或在设置里重选模型后生效。");

  const dir = path.dirname(MODELS_PATH);
  const olds = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("models.json.bak-") && n.includes("-modelsync"))
    .sort();
  for (const n of olds.slice(0, Math.max(0, olds.length - 5))) {
    try {
      fs.unlinkSync(path.join(dir, n));
    } catch {}
  }
}
