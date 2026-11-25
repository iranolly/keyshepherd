// 用法：
//   node add-key.mjs <名字> <钥匙>
//   node add-key.mjs <名字> --disable     （暂停一把钥匙）
//   node add-key.mjs <名字> --enable
//   node add-key.mjs --list
// 改完立即生效，不需要重启。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(DIR, "keys.json");
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
cfg.keys = cfg.keys || [];
const [name, value] = process.argv.slice(2);

function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function list() {
  console.log(`共 ${cfg.keys.length} 把钥匙：`);
  for (const k of cfg.keys) {
    const shown = k.key ? `${k.key.slice(0, 4)}…${k.key.slice(-4)}` : "(空)";
    console.log(`  ${k.name}  ${shown}  ${k.enabled === false ? "已停用" : "启用"}`);
  }
}

if (!name || name === "--list") {
  list();
} else {
  let entry = cfg.keys.find((k) => k.name === name);
  if (value === "--disable" || value === "--enable") {
    if (!entry) throw new Error(`没有叫 ${name} 的钥匙`);
    entry.enabled = value === "--enable";
  } else if (!value) {
    list();
    process.exit(0);
  } else {
    if (!entry) {
      entry = { name, key: "", route: "opencode-go", maxConcurrent: 10, enabled: true };
      cfg.keys.push(entry);
    }
    entry.key = value.trim();
    entry.enabled = true;
  }
  save();
  list();
}
