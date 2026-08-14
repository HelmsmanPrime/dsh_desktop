// 用 7-Zip SFX 模块手动生成可用的 portable exe。
// electron-builder 24.x 的 portable 目标在本仓库出现只生成 52KB 空壳的问题,
// 因此改用 7za 打包 win-unpacked + 7z.sfx + config.txt 制作自解压程序。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rcedit } = require("rcedit");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDir = path.resolve(__dirname, "..");
const releaseDir = path.join(desktopDir, "release");
const winUnpacked = path.join(releaseDir, "win-unpacked");
const outputExe = path.join(releaseDir, "DSH Desktop 0.1.0.exe");
const iconPath = path.join(desktopDir, "build", "icon.ico");

// 7z 工具:优先用系统 7z,否则用 node_modules 里的 7za
function find7za() {
  const candidates = [
    "C:/Program Files/7-Zip/7z.exe",
    "C:/Program Files (x86)/7-Zip/7z.exe",
    path.join(desktopDir, "node_modules", "7zip-bin", "win", "x64", "7za.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("找不到 7za/7z 工具");
}

// 7z SFX 模块:优先用仓库自带的 vendor/7z.sfx,再回退系统缓存
function findSfx() {
  const candidates = [
    path.join(desktopDir, "vendor", "7z.sfx"),
    "C:/Program Files/7-Zip/7z.sfx",
    "C:/Program Files (x86)/7-Zip/7z.sfx",
    "E:/tmp/7z.sfx",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    "找不到 7z.sfx。请先下载 7-Zip 安装程序并提取 7z.sfx,或放到 E:/tmp/7z.sfx"
  );
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`命令失败: ${cmd} ${args.join(" ")}`);
  }
  return r;
}

async function main() {
  if (!fs.existsSync(winUnpacked)) {
    throw new Error(`先构建 win-unpacked: ${winUnpacked}`);
  }

  // 说明:win-unpacked 主程序图标由 electron-builder 的 win.icon 在 --dir 阶段写入,
  // 无需再 rcedit(对 Electron 生成的 PE 调用 rcedit 会偶发截断文件)。

  const sfx = findSfx();
  const z7 = find7za();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dsh-sfx-"));
  const archivePath = path.join(tmpDir, "app.7z");
  const configPath = path.join(tmpDir, "config.txt");

  // SFX 配置:静默解压到临时目录并运行 DSH Desktop.exe
  fs.writeFileSync(
    configPath,
    `;!@Install@!UTF-8!
Title="DSH Desktop"
RunProgram="DSH Desktop.exe"
;!@InstallEnd@!
`
  );

  console.log("[sfx] 打包 win-unpacked...");
  run(z7, ["a", "-t7z", "-m0=lzma2", "-mx=5", archivePath, `${winUnpacked}/*`], {
    cwd: desktopDir,
  });

  console.log("[sfx] 先把图标写入 SFX 模块...");
  const sfxWithIcon = path.join(tmpDir, "7z-icon.sfx");
  fs.copyFileSync(sfx, sfxWithIcon);
  try {
    await rcedit(sfxWithIcon, { icon: iconPath });
  } catch (err) {
    // 部分 rcedit 无法处理原始 7z.sfx,继续用默认图标
    console.warn("[sfx] rcedit 对 SFX 模块失败:", err.message);
  }

  console.log("[sfx] 合并 SFX + config + archive...");
  const parts = [fs.readFileSync(sfxWithIcon), fs.readFileSync(configPath), fs.readFileSync(archivePath)];
  fs.writeFileSync(outputExe, Buffer.concat(parts));

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const sizeMB = (fs.statSync(outputExe).size / 1024 / 1024).toFixed(1);
  console.log(`[sfx] portable 已生成: ${outputExe} (${sizeMB} MB)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
