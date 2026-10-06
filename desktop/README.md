# 整体校色 · 桌面版

把网页版的前端原样装进 Electron 窗口，并内置原 `serve.ps1` 提供的本地接口，
双击即可运行，不需要另开命令行窗口，也不会在后台常驻额外进程（关掉窗口就全部退出）。

前端文件（`index.html`、`app.js`、`styles.css`、`white-balance.js`、`geometry.js`、
`curves.js`、`posterize.js`）都在仓库根目录，桌面版打包时直接引用，仓库里没有第二份副本。

## 目录结构

| 文件 | 作用 |
|---|---|
| `main.js` | Electron 主进程：创建窗口、菜单、`--smoke` / `--shot` 自检模式 |
| `bridge.js` | 进程内的本地 HTTP 服务：静态文件 + `/api/` 路由 |
| `comfy.js` | ComfyUI 客户端与任务管理：配置、进程启停、上传、轮询、结果归档 |
| `build/icon.ico` | 应用图标 |
| `test/bridge.test.js` | 桥接层回归测试（自带 mock ComfyUI，34 项） |
| `test/real-status.js` | 用真实 ComfyUI 安装目录检查探测结果 |
| `test/real-job.js` | 真实 ComfyUI 端到端联通测试（会按需启动 ComfyUI） |

## 开发与构建

```powershell
cd desktop
pnpm install      # 需要 Node 在 PATH 中：Electron 的安装脚本会调用 node
pnpm start        # 直接起窗口（开发模式）
pnpm test         # 桥接层回归测试
pnpm run dist     # 产出 dist\ColorAdjustApp-<版本>-portable.exe 与 dist\win-unpacked\
```

### 打包后自检

```powershell
.\dist\win-unpacked\ColorAdjustApp.exe --smoke
```

它会隐藏窗口加载 `tools/browser-check.html`，跑完网页版那 165 项端到端断言后打印
`RESULT n/n` 并以退出码表明结果（0 = 全通过）。

### 文档配图

```powershell
.\dist\win-unpacked\ColorAdjustApp.exe --shot=..\docs\desktop.png --shot-mode=manual
```

## 与网页版的差异

| 项 | 网页版 | 桌面版 |
|---|---|---|
| 启动方式 | `start.cmd`（PowerShell 服务 + 浏览器） | 双击 `ColorAdjustApp.exe` |
| 界面 | 同一套前端文件 | 同一套前端文件（Electron 窗口） |
| 本地接口 | `serve.ps1` 提供 | 进程内 Node 桥接提供，契约一致 |
| AI 结果位置 | 工程目录 `outputs\` | `图片\ColorAdjustApp\` |
| ComfyUI 配置 | `%LOCALAPPDATA%\ColorAdjustApp\comfy.json` | 同一个文件（两个版本共用） |
| 请求并发 | 串行（一次一个连接） | 并发 |

> 构建提示：Windows 上 `electron-builder` 首次运行会解压 `winCodeSign`，其中包含
> macOS 的符号链接。若没有开发者模式权限，解压会失败并报
> `Cannot create symbolic link`，可以先用 7-Zip 手动解压（排除 `darwin` 目录）到
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<hash>` 再重新构建。
