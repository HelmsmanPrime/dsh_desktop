#!/usr/bin/env node
/**
 * 构建 DSH Desktop 后端运行副本(desktop/.backend/)
 *
 * dsh web 服务通过 `node apps/cli/lib/bin.js web` 启动,其依赖解析依赖仓库内的
 * pnpm workspace 布局(apps/cli/node_modules 的相对链接 + 根 node_modules/.pnpm)。
 * 本脚本解析「运行时依赖闭包」,把闭包内所有包解引用拷贝为扁平的 backend 副本,
 * 使打包后的应用可以脱离仓库独立运行:
 *
 *   .backend/
 *     package.json                     # 根包名锚点
 *     apps/cli/{lib,config,package.json}
 *     node_modules/@deepseek-ai/*      # 闭包内的 workspace 包(真实拷贝)
 *     node_modules/<third-party>       # 闭包内的第三方依赖(真实拷贝)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "..");
const outDir = path.join(desktopDir, ".backend");
const runtimeDir = path.join(desktopDir, "runtime");
const cliDir = path.join(repoRoot, "apps", "cli");
const rootNodeModules = path.join(repoRoot, "node_modules");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * 解析依赖真实目录(统一规则):
 * 从依赖者目录逐级向上找 node_modules/<name>(覆盖 apps/cli/node_modules、
 * packages 下各包的 node_modules、根 node_modules),再解引用链接得到真实目录。
 */
function resolveDep(name, fromDir) {
  let cur = fromDir;
  for (;;) {
    const cand = path.join(cur, "node_modules", name);
    try {
      fs.statSync(cand);
      return fs.realpathSync(cand);
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const rootLink = path.join(rootNodeModules, name);
  try {
    return fs.realpathSync(rootLink);
  } catch {
    return null;
  }
}

/**
 * 平台过滤:跳过非当前平台(win32)的 optional 平台包(如 koffi-linux-x64、
 * sharp-darwin-arm64),避免体积膨胀。名字不含平台标识的 optional 包(如
 * bufferutil、utf-8-validate)正常保留。
 */
function isForeignPlatform(name) {
  const lower = name.toLowerCase();
  if (lower.includes("win32") || lower.includes("win-x64") || lower.includes("win32-x64")) return false;
  return /linux|darwin|freebsd|openbsd|android|musl/.test(lower);
}

/** 闭包 BFS:从 apps/cli 的 dependencies 开始(含 optionalDependencies,用于原生平台包) */
const closure = new Map(); // name -> realDir
const queue = [
  {
    name: "@deepseek-ai/dsh",
    dir: cliDir,
    manifest: readJson(path.join(cliDir, "package.json")),
  },
];

while (queue.length) {
  const cur = queue.shift();
  if (closure.has(cur.name)) continue;
  closure.set(cur.name, cur.dir);
  const deps = {
    ...(cur.manifest.dependencies || {}),
    ...(cur.manifest.optionalDependencies || {}),
    ...(cur.manifest.peerDependencies || {}),
  };
  for (const dep of Object.keys(deps)) {
    if (closure.has(dep) || queue.some((q) => q.name === dep)) continue;
    const isOptional = Object.prototype.hasOwnProperty.call(cur.manifest.optionalDependencies || {}, dep);
    if (isOptional && isForeignPlatform(dep)) continue;
    const dir = resolveDep(dep, cur.dir);
    if (!dir) {
      if (!isOptional) console.warn(`[skip] 无法解析依赖: ${dep} (来自 ${cur.name})`);
      continue;
    }
    try {
      queue.push({
        name: dep,
        dir,
        manifest: readJson(path.join(dir, "package.json")),
      });
    } catch {
      console.warn(`[skip] ${dep} 缺少 package.json`);
    }
  }
}

/** 带重试的拷贝:规避杀毒软件/其他进程短暂占用文件(EPERM/EPIPE/EBUSY) */
function cpRetry(s, d, attempt = 0) {
  try {
    fs.cpSync(s, d, { recursive: true, dereference: true });
    return true;
  } catch (err) {
    const transient = /EPIPE|EPERM|EBUSY|ETXTBSY|EMFILE|ENOTEMPTY|EACCES/i.test(
      err.code || err.message
    );
    if (transient && attempt < 5) {
      const wait = 500 * (attempt + 1);
      console.warn(`[retry ${attempt + 1}] 文件被占用, ${wait}ms 后重试: ${path.basename(s)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      return cpRetry(s, d, attempt + 1);
    }
    console.warn(`[warn] 拷贝失败 ${s}: ${err.message}`);
    return false;
  }
}

/** 拷贝包目录(排除 node_modules 子目录,避免重复) */
function copyPackage(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (entry === "node_modules" || entry === ".git") continue;
    cpRetry(path.join(src, entry), path.join(dest, entry));
  }
}

console.log("构建 backend 闭包...");
// 清空旧产物;部分环境(沙盒)拦截 rmSync,降级为重命名
try {
  fs.rmSync(outDir, { recursive: true, force: true });
} catch {
  try {
    fs.renameSync(outDir, `${outDir}.stale-${Date.now()}`);
  } catch {
    /* 忽略:无法清理时后续拷贝会覆盖 */
  }
}
fs.mkdirSync(path.join(outDir, "apps", "cli"), { recursive: true });

// 根锚点
fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(outDir, "package.json"));

// apps/cli(不含 node_modules/src/tests)
for (const entry of ["lib", "config", "package.json"]) {
  const src = path.join(cliDir, entry);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(outDir, "apps", "cli", entry), {
      recursive: true,
      dereference: true,
    });
  }
}

// 闭包包平铺到 node_modules
for (const [name, dir] of closure) {
  const dest = path.join(outDir, "node_modules", name);
  copyPackage(dir, dest);
}

// 内置 node.exe(打包后无需用户安装 node)
fs.mkdirSync(runtimeDir, { recursive: true });
const candidates = [
  process.env.DSH_DESKTOP_NODE,
  process.execPath, // 运行本脚本的 node 自身,最可靠(保证架构/路径正确)
  "C:/Users/任福豪/.workbuddy/binaries/node/versions/22.22.2/node.exe",
  "C:/Program Files/nodejs/node.exe",
  "C:/Program Files (x86)/nodejs/node.exe",
].filter(Boolean);
let nodeCopied = false;
for (const c of candidates) {
  try {
    if (fs.existsSync(c)) {
      fs.copyFileSync(c, path.join(runtimeDir, "node.exe"));
      nodeCopied = true;
      console.log(`内置 node.exe: ${c}`);
      break;
    }
  } catch {
    /* try next */
  }
}

function fmtMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

console.log("\nbackend 构建完成:");
console.log(`  闭包包: ${closure.size} 个`);
console.log(`  目录: ${outDir} (${fmtMB(dirSize(outDir))})`);
console.log(`  node.exe: ${nodeCopied ? "已内置" : "未找到(将回退系统 node)"}`);
