// 用捆绑的 makensis + nsis7z 插件手动生成可用的 NSIS 安装包。
// electron-builder 24.x 的 nsis 目标在本仓库会把最终 exe 打包成 ~60KB 空壳
// (其"追加 7z 负载到 NSIS 头"步骤在本沙箱静默失败),因此改为:
//   1) 用 7za 把 win-unpacked 打成 app.7z
//   2) 用 nsis7z 插件把 app.7z 直接嵌入 NSIS 脚本(File 指令),安装时解压
//   3) rcedit 写入 DeepSeek 图标
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
const app7z = path.join(releaseDir, "app.7z");
const iconPath = path.join(desktopDir, "build", "icon.ico");
const outExe = path.join(releaseDir, "DSH Desktop Setup 0.1.0.exe");
const nsiTemplate = path.join(__dirname, "installer.nsi");

const LOCALAPPDATA =
  process.env.LOCALAPPDATA || "C:/Users/Default/AppData/Local";
const nsisDir = path.join(
  LOCALAPPDATA,
  "electron-builder",
  "Cache",
  "nsis"
);
const makensis = path.join(nsisDir, "nsis-3.0.4.1", "makensis.exe");
const pluginsSrc = path.join(
  nsisDir,
  "nsis-resources-3.4.1",
  "plugins",
  "x86-unicode"
);

function find7za() {
  const cands = [
    "C:/Program Files/7-Zip/7z.exe",
    "C:/Program Files (x86)/7-Zip/7z.exe",
    path.join(desktopDir, "node_modules", "7zip-bin", "win", "x64", "7za.exe"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("找不到 7za/7z 工具");
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
  if (!fs.existsSync(makensis)) {
    throw new Error(`找不到 makensis: ${makensis}`);
  }

  // 说明:win-unpacked 主程序的图标由 electron-builder 的 win.icon 在 --dir 阶段写入,
  // 安装包图标由下方 makensis 的 Icon 指令写入,均无需再用 rcedit(对 NSIS/Electron 生成的
  // PE 调用 rcedit 会偶发 "Unable to commit changes" 并截断文件,反而破坏产物)。

  // 1) 7za 压缩 win-unpacked -> app.7z
  const z7 = find7za();
  console.log("[installer] 压缩 win-unpacked -> app.7z ...");
  if (fs.existsSync(app7z)) fs.rmSync(app7z, { force: true });
  run(z7, ["a", "-t7z", "-m0=lzma2", "-mx=5", app7z, `${winUnpacked}/*`], {
    cwd: desktopDir,
  });
  const szMB = fs.statSync(app7z).size / 1024 / 1024;
  console.log(`[installer] app.7z 大小: ${szMB.toFixed(1)} MB`);
  if (szMB < 50) {
    throw new Error(`app.7z 异常偏小(${szMB} MB),win-unpacked 可能不完整`);
  }

  // 3) nsis7z 插件与脚本放到 ASCII 临时目录,规避中文用户名路径下 makensis 读脚本报
  //    "Bad text encoding" 的问题(makensis 3.0.4.1 对命令行 UTF-8 路径支持不佳)
  const tmp = "E:/tmp/dsh-nsis-build";
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(
    path.join(pluginsSrc, "nsis7z.dll"),
    path.join(tmp, "nsis7z.dll")
  );
  // copy app.7z + icon.ico next to the .nsi so File/Icon reference them by relative path
  fs.copyFileSync(app7z, path.join(tmp, "app.7z"));
  fs.copyFileSync(iconPath, path.join(tmp, "icon.ico"));

  // 4) 注入占位符生成 NSI
  let nsi = fs.readFileSync(nsiTemplate, "utf8");
  nsi = nsi
    .replaceAll("@@PRODUCT_NAME@@", "DSH Desktop")
    .replaceAll("@@PRODUCT_VERSION@@", "0.1.0")
    .replaceAll("@@EXE_NAME@@", "DSH Desktop.exe")
    .replaceAll("@@OUTFILE@@", outExe.replace(/\\/g, "\\\\"))
    .replaceAll("@@PLUGINS@@", tmp.replace(/\\/g, "\\\\"));
  const nsiPath = path.join(tmp, "installer.nsi");
  fs.writeFileSync(nsiPath, nsi);

  // 5) 编译 NSIS 安装包(打印 makensis 输出以便诊断)
  //    注意:本仓库捆绑的 makensis 3.0.4.1 对相对 File/Icon 路径按"当前工作目录"
  //    解析(而非脚本目录),因此必须把 cwd 设为临时目录,否则 app.7z 静默丢失 -> 空壳
  console.log("[installer] 编译 NSIS 安装包 ...");
  // makensis 对相对 File/Icon 路径按"进程当前目录"解析。Node 子进程的 cwd 选项在本环境
  // 不被 makensis 采纳,故改为直接 process.chdir 到临时目录,再相对执行(等价于手动
  // `cd tmp && makensis installer.nsi`,该方式经验证可正确嵌入 130MB 负载)。
  const savedCwd = process.cwd();
  let mr;
  try {
    process.chdir(tmp);
    mr = spawnSync(makensis, ["/V2", "installer.nsi"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    console.log(mr.stdout);
    if (mr.stderr) console.error(mr.stderr);
    if (mr.status !== 0) {
      throw new Error(`makensis 失败 (${mr.status})`);
    }
  } finally {
    process.chdir(savedCwd);
  }
  console.log(mr.stdout);
  if (mr.stderr) console.error(mr.stderr);
  if (mr.status !== 0) {
    throw new Error(`makensis 失败 (${mr.status})`);
  }

  // 6) 图标已由 makensis 的 Icon 指令原生写入;rcedit 对 NSIS 生成的 PE 会
  //    "Unable to commit changes",这里仅作尽力而为的兜底,失败不阻断构建
  if (!fs.existsSync(outExe)) {
    throw new Error(`makensis 未生成 ${outExe}`);
  }
  const outMB = fs.statSync(outExe).size / 1024 / 1024;
  // 防呆:若产物过小,说明 app.7z 未被嵌入(空壳),直接报错
  if (outMB < 100) {
    throw new Error(
      `安装包仅 ${outMB.toFixed(1)} MB,疑似空壳(app.7z 未嵌入),请检查 makensis 日志`
    );
  }
  console.log(`[installer] 安装包已生成: ${outExe} (${outMB.toFixed(1)} MB)`);

  // 7) 清理中间产物(app.7z 与临时目录;win-unpacked 体积大,留待手动清理)
  for (const f of [
    path.join(releaseDir, "DSH Desktop Setup 0.1.0.exe.blockmap"),
  ]) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  fs.rmSync(app7z, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("[installer] 已清理 app.7z 与临时文件(win-unpacked 保留)");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
