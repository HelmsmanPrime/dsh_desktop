// DSH Desktop — Electron 主进程
// 职责:启动本地 dsh web 服务(内置 node + backend 闭包),等待就绪后加载 UI。
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 36320;
const APP_TITLE = "DSH Desktop";

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

function waitForServer(timeoutMs = 180000) {
  const url = `http://127.0.0.1:${PORT}/`;
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

async function startBackend() {
  const root = backendRoot();
  const binJs = path.join(root, "apps", "cli", "lib", "bin.js");
  if (!fs.existsSync(binJs)) {
    throw new Error(`未找到 dsh 后端入口: ${binJs}\n请先运行 npm run build:backend`);
  }
  const dshHome = path.join(app.getPath("userData"), "dsh-home");
  fs.mkdirSync(dshHome, { recursive: true });

  backendProc = spawn(nodeBinary(), [binJs, "web", "--port", String(PORT)], {
    cwd: root,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  backendProc.stdout.on("data", (d) => console.log("[dsh]", String(d).trim()));
  backendProc.stderr.on("data", (d) => console.error("[dsh]", String(d).trim()));
  backendProc.on("exit", (code, sig) => {
    console.log(`[dsh] backend exited (${code ?? sig})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend-exited", { code, sig });
    }
  });
  await waitForServer();
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
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox(APP_TITLE, `无法启动 dsh 服务:\n\n${err.message}`);
    app.quit();
    return;
  }
  createWindow();
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
