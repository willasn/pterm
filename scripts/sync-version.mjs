// 版本号唯一来源是 package.json。
// 本脚本把 package.json 的 version 同步到 src-tauri/Cargo.toml，
// 使后端 app_info 展示的 env!("CARGO_PKG_VERSION") 与打包/前端版本保持一致。
// 由 package.json 的 "version" 生命周期脚本在 `npm version` 时自动调用。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
// 只匹配 [package] 段的行首 version（依赖里的 version 都在行内，不会命中）。
const next = cargo.replace(/^version\s*=\s*".*"$/m, `version = "${version}"`);

if (next === cargo) {
  console.log(`[sync-version] Cargo.toml 已是 ${version}`);
} else {
  writeFileSync(cargoPath, next);
  console.log(`[sync-version] Cargo.toml -> ${version}`);
}

// `npm version` 时把 Cargo.toml 一并纳入这次版本提交，确保 tag 指到的代码版本正确。
if (process.env.npm_lifecycle_event === "version") {
  execFileSync("git", ["add", "src-tauri/Cargo.toml"], { cwd: root });
}
