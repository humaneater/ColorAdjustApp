/**
 * 整体校色 · 桌面版主进程。
 *
 * 设计目标：网页版和桌面版共用同一套前端文件（index.html / app.js / 各模块），
 * 桌面版只多做两件事：
 *   1. 进程内起一个只监听 127.0.0.1 的小服务，把同一批静态文件按网页版的
 *      /api/... 契约提供出去（因此 app.js 一行都不用改，排版自然完全一致）；
 *   2. 用 Electron 窗口显示它，关掉窗口即退出，不需要另外开后台服务。
 *
 * 支持 `--smoke`：隐藏窗口加载 tools/browser-check.html，跑完那套端到端断言后
 * 把结果打到 stdout 并按结果设置退出码，用于打包后的自检。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { app, BrowserWindow, Menu, shell, dialog, nativeImage } = require("electron");

const { createBridgeServer } = require("./bridge");

const isSmokeRun = process.argv.includes("--smoke");
const shotArgument = process.argv.find((item) => item.startsWith("--shot="));
const shotPath = shotArgument ? shotArgument.slice("--shot=".length) : "";
const shotMode = shotArgument
  ? (process.argv.find((item) => item.startsWith("--shot-mode=")) || "").slice(
      "--shot-mode=".length,
    ) || "manual"
  : "";

// 必须在 app ready 之前设置：自检时用软件渲染，保证没有 GPU 的会话也能跑 WebGL
if (isSmokeRun || shotPath) {
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
}

/**
 * 遮罩解码：桥接层要判断人脸遮罩里有没有亮起来的像素。
 * Electron 自带 nativeImage，不用再引第三方 PNG 解码库。
 */
function decodeMaskPixels(filePath) {
  const image = nativeImage.createFromPath(filePath);

  if (image.isEmpty()) {
    return null;
  }

  const size = image.getSize();

  return {
    data: image.toBitmap(),
    width: size.width,
    height: size.height,
    channels: 4,
  };
}

/** 前端文件所在目录：开发时是仓库根目录，打包后是 resources/app。 */
function resolveWebRoot() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "app") : "",
    path.join(__dirname, ".."),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  throw new Error("找不到前端文件（index.html）");
}

/** AI 结果保存目录：图片库下单独建一个文件夹，方便在资源管理器里找。 */
function resolveOutputDir() {
  const pictures = app.getPath("pictures") || app.getPath("userData");

  return path.join(pictures, "ColorAdjustApp");
}

let mainWindow = null;
let bridge = null;

function buildMenu(webRoot) {
  return Menu.buildFromTemplate([
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { type: "separator" },
        { label: "全屏", role: "togglefullscreen" },
        { label: "开发者工具", role: "toggleDevTools" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "打开结果文件夹",
          click: () => {
            const dir = resolveOutputDir();

            fs.mkdirSync(dir, { recursive: true });
            shell.openPath(dir);
          },
        },
        {
          label: "关于",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于",
              message: `整体校色 桌面版 v${app.getVersion()}`,
              detail:
                "与网页版共用同一套界面、色彩调整与几何逻辑。\n" +
                `界面文件：${webRoot}\n` +
                `AI 结果目录：${resolveOutputDir()}`,
              buttons: ["好"],
            });
          },
        },
      ],
    },
  ]);
}

async function createMainWindow(port) {
  const window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    show: !isSmokeRun,
    autoHideMenuBar: true,
    backgroundColor: "#0d0f12",
    title: "整体校色",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 自检时窗口是隐藏的，不能让它把定时器降频
      backgroundThrottling: false,
    },
  });

  window.setMenuBarVisibility(false);

  // 前端里的外链一律交给系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});

    return { action: "deny" };
  });

  const target = isSmokeRun
    ? `http://127.0.0.1:${port}/tools/browser-check.html`
    : shotPath
      ? `http://127.0.0.1:${port}/tools/browser-check.html?shot=${encodeURIComponent(shotMode)}`
      : `http://127.0.0.1:${port}/index.html`;

  await window.loadURL(target);

  return window;
}

/** --shot=<文件>：把窗口截一张图（用来生成文档配图）。 */
async function runShot(window) {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    if (window.webContents.getTitle() === "SHOT-READY") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await new Promise((resolve) => setTimeout(resolve, 800));

  const image = await window.webContents.capturePage();

  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, image.toPNG());
  process.stdout.write(`截图已保存：${shotPath}\n`);
}

/** --smoke：等 browser-check 跑完，打印报告并返回退出码。 */
async function runSmoke(window) {
  const timeoutAt = Date.now() + 180000;
  const reportPath =
    (process.argv.find((item) => item.startsWith("--smoke-out=")) || "").slice(
      "--smoke-out=".length,
    ) || path.join(os.tmpdir(), "ColorAdjustApp", "smoke-result.txt");
  let title = "";

  while (Date.now() < timeoutAt) {
    title = window.webContents.getTitle();

    if (/^RESULT \d+\/\d+$/.test(title)) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const report = await window.webContents
    .executeJavaScript(
      "(() => { const node = document.querySelector('#report'); return node ? node.textContent : ''; })()",
      true,
    )
    .catch(() => "");

  const output = `${report}\n--\n${title}\n`;

  process.stdout.write(output);

  // 单文件 portable 版是 NSIS 自解压包，它的子进程 stdout 接不回调用方，
  // 所以再把结果落一份文件，方便打包后自检。
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, output, "utf8");
  } catch (error) {
    process.stderr.write(`写自检结果失败：${error?.message || error}\n`);
  }

  const match = /^RESULT (\d+)\/(\d+)$/.exec(title);

  if (!match) {
    process.stdout.write("SMOKE 未在 180 秒内拿到结果\n");

    return 1;
  }

  return match[1] === match[2] ? 0 : 1;
}

async function start() {
  const webRoot = resolveWebRoot();

  bridge = createBridgeServer({
    webRoot,
    outputDir: resolveOutputDir(),
    decodeMaskPixels,
    log: (message) => process.stdout.write(`[bridge] ${message}\n`),
  });

  const port = await bridge.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  process.stdout.write(`整体校色 桌面版 v${app.getVersion()} · ${baseUrl}\n`);

  mainWindow = await createMainWindow(port);

  if (isSmokeRun) {
    const code = await runSmoke(mainWindow);

    app.exit(code);

    return;
  }

  if (shotPath) {
    await runShot(mainWindow);
    app.exit(0);

    return;
  }

  Menu.setApplicationMenu(buildMenu(webRoot));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.focus();
    }
  });

  app.whenReady().then(start).catch((error) => {
    const message = error?.stack || String(error);

    process.stderr.write(`启动失败：${message}\n`);

    if (isSmokeRun) {
      process.stdout.write(`SMOKE 启动失败：${message}\n`);
    } else {
      dialog.showErrorBox("整体校色启动失败", message);
    }

    app.exit(1);
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", () => bridge?.close());
}
