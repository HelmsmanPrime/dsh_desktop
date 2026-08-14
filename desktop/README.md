# DSH Desktop

DeepSeek Harness(`dsh`)的桌面端应用 —— 基于 Electron,包装本地 `dsh web` 服务。

## 功能特性

- 自动启动并管理本地 `dsh web` 服务(内置 Node.js 运行时)
- 集成 WebView 窗口作为完整 UI
- 自动清理 `dsh web` 子进程(窗口关闭时)
- 独立用户数据目录(`%APPDATA%/DSH Desktop/dsh-home`),与其他 dsh 安装互不干扰
- NSIS 安装包 + 便携版(Windows)

## 仓库结构

```
desktop/
  main.js              # Electron 主进程:启动后端 + 创建窗口
  preload.js           # 预加载脚本(上下文隔离)
  package.json         # 依赖与 electron-builder 打包配置
  scripts/
    build-backend.mjs  # 闭包构建:解析依赖并拷贝到 .backend/
    make-icon.mjs      # 生成应用图标
  build/               # 图标资源(已生成)
  .backend/            # 闭包构建产物(打包后作为 extraResources)
  runtime/             # 内置 node.exe(打包后无需用户安装 node)
```

## 开发模式

```sh
cd desktop
npm install              # 安装 electron + electron-builder
npm run build:backend    # 构建后端闭包到 .backend/
npm start                # 启动 Electron 应用(自动调用 .backend)
```

## 打包发布

```sh
cd desktop
npm run dist             # 输出 release/ 下的 NSIS 安装包与便携版
```

输出:
- `release/DSH Desktop Setup <version>.exe` —— NSIS 安装包
- `release/DSH Desktop <version>.exe` —— 便携版(免安装)

## 工作原理

1. **后端**:`dsh web` 是基于 Cordis 插件架构的本地服务,通过 `node apps/cli/lib/bin.js web --port 36320` 启动,提供完整的 dsh Web UI。
2. **闭包构建**(`scripts/build-backend.mjs`):遍历 `apps/cli` 的运行时依赖闭包,把:
   - `apps/cli/{lib, config, package.json}` 复制为可独立运行的后端
   - 所有闭包内的 workspace 包(`@deepseek-ai/*`)与第三方依赖(含 `optionalDependencies` 中的原生平台包,如 `@koromix/koffi-win32-x64`、`@img/sharp-win32-x64`)扁平拷贝到 `.backend/node_modules/`
   - 平台过滤:跳过 `linux/darwin/freebsd/openbsd/android` 的预编译包,仅保留 win32
3. **运行时**:Electron 主进程以内置 `node.exe` 启动后端子进程,等待 `127.0.0.1:36320` 就绪后,创建 `BrowserWindow` 加载 UI。窗口关闭或应用退出时自动 kill 后端子进程。
4. **用户数据隔离**:`DSH_HOME` 指向 `app.getPath("userData")/dsh-home`,确保桌面端的 session / 配置 / profile 与其他 dsh 安装隔离。

## 环境要求

- Windows 10/11(当前已验证)
- 无需用户机器预装 Node.js(运行时内置)
- 网络:首次启动会下载会话/插件元数据(若需要 DEEPSEEK_API_KEY,请在 UI 内配置)

## 故障排查

- **后端启动超时**:查看 `%APPDATA%/DSH Desktop/dsh-home/profiles/web` 日志,常见原因:原生二进制缺失 → 重新运行 `npm run build:backend`。
- **端口被占用**:修改 `desktop/main.js` 中的 `PORT` 常量并重建闭包。
- **加载插件失败**:检查 `.backend/node_modules/@koromix/`、`@img/` 目录是否包含 win32-x64 平台包。