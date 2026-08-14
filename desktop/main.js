// DSH Desktop — Electron 主进程
// 职责:立即显示窗口(加载动画),后台启动本地 dsh web 服务(内置 node + backend 闭包),
// 就绪后加载 UI;失败时在窗口内展示错误详情。
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { APP_ICON_DATA_URI } = require("./icon-data.js");

const APP_TITLE = "DSH Desktop";
const BASE_PORT = 36320;
const MAX_PORT_TRIES = 20;

// 落盘日志:便于排查后端启动失败(写到用户数据目录)
function logPath() {
  try {
    return path.join(app.getPath("userData"), "dsh-desktop.log");
  } catch {
    return path.join(os.tmpdir(), "dsh-desktop.log");
  }
}
function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  try {
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

// DSH_HOME:使用应用数据目录,与命令行 dsh 的 ~/.dsh 隔离
function dshHomePath() {
  return path.join(app.getPath("userData"), "dsh-home");
}

// 备份并重置 DSH_HOME(用于后端因数据损坏无法启动时自救)
function resetDshHome() {
  const home = dshHomePath();
  const bak = `${home}.bak.${Date.now()}`;
  try {
    if (fs.existsSync(home)) fs.renameSync(home, bak);
    fs.mkdirSync(home, { recursive: true });
    log("DSH_HOME 已重置:", home, "原目录备份到:", bak);
    return true;
  } catch (err) {
    log("DSH_HOME 重置失败:", err.message);
    return false;
  }
}

// 后端根目录:打包后为 resources/backend,开发模式为仓库根
function backendRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "backend");
  return path.resolve(__dirname, "..");
}

// 运行时 node:打包后为 resources/runtime/node.exe,开发模式用系统 node
function nodeBinary() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "runtime", "node.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.env.DSH_DESKTOP_NODE || "node";
}

// 探测可用端口(避免与已运行实例/其他程序冲突)
function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attempts) => {
      if (attempts <= 0) return reject(new Error("未找到可用端口"));
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => tryPort(port + 1, attempts - 1));
      srv.listen(port, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    };
    tryPort(start, MAX_PORT_TRIES);
  });
}

function waitForServer(port, timeoutMs = 240000) {
  const url = `http://127.0.0.1:${port}/`;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`dsh web 服务启动超时(${(timeoutMs / 1000).toFixed(0)}s)`));
          return;
        }
        setTimeout(attempt, 600);
      });
      req.setTimeout(3000, () => req.destroy());
    };
    attempt();
  });
}

let backendProc = null;
let mainWindow = null;

const LOADING_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;height:100%;background:#0f1115;color:#e8ecf4;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
  .logo{width:72px;height:72px;border-radius:18px;object-fit:contain;display:block;
    box-shadow:0 10px 34px rgba(0,0,0,.45)}
  .title{font-size:20px;font-weight:600;letter-spacing:.5px}
  .spinner{width:28px;height:28px;border:3px solid #2d60ff33;border-top-color:#4d6bfe;border-radius:50%;
    animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .hint{font-size:13px;color:#8b93a7}
</style></head><body><div class="wrap">
  <img class="logo" alt="DSH Desktop" src="${APP_ICON_DATA_URI}"/>
  <div class="title">正在启动 dsh 服务…</div>
  <div class="spinner"></div>
  <div class="hint">首次启动可能需要 30-60 秒</div>
</div></body></html>`;

function errorPage(message) {
  const esc = String(message).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;height:100%;background:#0f1115;color:#e8ecf4;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;text-align:center}
  .icon{font-size:44px}.title{font-size:20px;font-weight:600}.msg{font-size:13px;color:#aab3c5;max-width:560px;word-break:break-all;line-height:1.6}
  code{background:#1a2030;padding:2px 6px;border-radius:4px}
</style></head><body><div class="wrap">
  <div class="icon">⚠️</div>
  <div class="title">dsh 服务启动失败</div>
  <div class="msg">${esc}</div>
</div></body></html>`;
}

async function startBackend(port, timeoutMs = 45000) {
  const root = backendRoot();
  const binJs = path.join(root, "apps", "cli", "lib", "bin.js");
  if (!fs.existsSync(binJs)) {
    throw new Error(`未找到 dsh 后端入口: ${binJs}\n\n请确认安装包完整(缺少 backend 资源)。`);
  }
  const dshHome = dshHomePath();
  fs.mkdirSync(dshHome, { recursive: true });

  return new Promise((resolve, reject) => {
    // 清空 NODE_OPTIONS:避免宿主环境(如 WorkBuddy)注入的 shim / --use-system-ca
    // 干扰后端进程;DSH_HOME 隔离到应用数据目录
    const env = { ...process.env, DSH_HOME: dshHome, NODE_OPTIONS: "" };
    const node = nodeBinary();
    log("starting backend:", node, binJs, "--port", port, "cwd=", root);
    backendProc = spawn(node, [binJs, "web", "--port", String(port)], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderrTail = "";
    backendProc.stdout.on("data", (d) => console.log("[dsh]", String(d).trim()));
    backendProc.stderr.on("data", (d) => {
      const s = String(d);
      stderrTail = (stderrTail + s).slice(-4000);
      console.error("[dsh]", s.trim());
      log("[dsh stderr]", s.trim());
    });
    backendProc.on("exit", (code, sig) => {
      console.log(`[dsh] backend exited (${code ?? sig})`);
      log("[dsh] backend exited", code ?? sig);
      if (mainWindow && !mainWindow.isDestroyed() && code !== 0) {
        mainWindow.loadURL(
          "data:text/html;charset=utf-8," +
            encodeURIComponent(errorPage(`后端进程意外退出(exit ${code ?? sig})。\n\n${stderrTail}`))
        );
      }
    });
    waitForServer(port, timeoutMs)
      .then(resolve)
      .catch((err) => {
        reject(new Error(`${err.message}\n\n后端输出:\n${stderrTail || "(无输出)"}`));
      });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: APP_TITLE,
    autoHideMenuBar: true,
    backgroundColor: "#0f1115",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createWindow();
  // 立即显示加载页,再异步启动后端
  mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOADING_HTML));

  async function tryStart(resetOnFailure) {
    let port;
    try {
      port = await findFreePort(BASE_PORT);
      // 首次给 45s,重置重试后给 4 分钟
      await startBackend(port, resetOnFailure ? 45000 : 240000);
    } catch (err) {
      console.error("启动失败:", err);
      log("启动失败:", err && err.message ? err.message : err);

      if (resetOnFailure && err.message && err.message.includes("超时")) {
        log("后端启动超时,准备重置 DSH_HOME 后重试一次...");
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(
            "data:text/html;charset=utf-8," +
              encodeURIComponent(
                LOADING_HTML.replace(
                  "正在启动 dsh 服务…",
                  "检测到数据异常,正在重置并重启服务…"
                )
              )
          );
        }
        if (backendProc && !backendProc.killed) {
          try {
            backendProc.kill();
          } catch {
            /* ignore */
          }
        }
        if (resetDshHome()) {
          return tryStart(false);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(
          "data:text/html;charset=utf-8," + encodeURIComponent(errorPage(err.message))
        );
      }
      return null;
    }
    return port;
  }

  const port = await tryStart(true);
  if (!port) return;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    mainWindow.setTitle(APP_TITLE);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProc && !backendProc.killed) {
    try {
      backendProc.kill();
    } catch {
      /* ignore */
    }
  }
});
