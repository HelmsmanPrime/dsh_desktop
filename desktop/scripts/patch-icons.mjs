// electron-builder afterAllArtifactBuild hook: 用 rcedit 重新写入应用图标。
// 原因:electron-builder 对 NSIS / portable 最终产物设置图标时会把 group icon 目录的 ID 顺序写反,
// 导致 Windows 资源管理器显示默认程序图标。win-unpacked 主程序不受影响,但统一再写一次更保险。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rcedit } = require("rcedit");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const iconPath = path.resolve(__dirname, "..", "build", "icon.ico");

export default async function patchIcons(context) {
  if (!fs.existsSync(iconPath)) {
    console.warn(`[patch-icons] 图标文件不存在: ${iconPath}`);
    return null;
  }

  const artifacts = context?.artifactPaths || [];
  const targets = artifacts.filter((p) => p.endsWith(".exe"));
  if (targets.length === 0) {
    console.log("[patch-icons] 无 exe 产物,跳过");
    return null;
  }

  console.log(`[patch-icons] 将图标 ${iconPath} 写入 ${targets.length} 个 exe:`);
  for (const exe of targets) {
    try {
      await rcedit(exe, { icon: iconPath });
      console.log(`  ✓ ${path.basename(exe)}`);
    } catch (err) {
      console.error(`  ✗ ${path.basename(exe)}: ${err.message}`);
    }
  }
  return null;
}

// 支持命令行直接运行: node scripts/patch-icons.mjs <exe...>
if (process.argv.length > 2) {
  const paths = process.argv.slice(2);
  await patchIcons({ artifactPaths: paths });
}
