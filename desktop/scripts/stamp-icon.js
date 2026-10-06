/**
 * 给构建出来的 exe 补上图标与版本信息。
 *
 * 为什么需要这一步：electron-builder 的签名/资源编辑依赖 winCodeSign 压缩包，
 * 里面含 macOS 的符号链接，在没开开发者模式的 Windows 上解压会失败
 * （Cannot create symbolic link）。因此构建时关掉 signAndEditExecutable，
 * 再用纯 exe 的 rcedit 补图标与版本号——效果一样，但不需要符号链接权限。
 *
 * 运行：node scripts/stamp-icon.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopDir, "..");
const iconPath = path.join(desktopDir, "build", "icon.ico");
const distDir = path.join(desktopDir, "dist");
const version = JSON.parse(
  fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"),
).version;

function findRcedit() {
  const candidates = [
    path.join(desktopDir, "node_modules", "rcedit", "bin", "rcedit-x64.exe"),
    path.join(desktopDir, "node_modules", "rcedit", "bin", "rcedit.exe"),
    path.join(
      process.env.LOCALAPPDATA || "",
      "electron-builder",
      "Cache",
      "winCodeSign",
    ),
  ];

  for (const candidate of candidates.slice(0, 2)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 退路：electron-builder 缓存里已经解出来的 rcedit
  const cacheDir = candidates[2];

  if (fs.existsSync(cacheDir)) {
    for (const entry of fs.readdirSync(cacheDir)) {
      const candidate = path.join(cacheDir, entry, "rcedit-x64.exe");

      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

function targets() {
  // 只处理解包目录里的主程序。
  // 单文件 portable 版**不能**碰：它是 NSIS 自解压包，数据附加在 PE 之后，
  // rcedit 重写资源时会把那段数据截掉（83MB 会变成 50KB）。
  // portable 的图标由 NSIS 在打包时用 build/icon.ico 直接写进外壳，本来就是对的。
  const unpacked = path.join(distDir, "win-unpacked", "ColorAdjustApp.exe");

  return fs.existsSync(unpacked) ? [unpacked] : [];
}

async function main() {
  const rcedit = findRcedit();

  if (!rcedit) {
    console.error("找不到 rcedit，请先安装依赖：pnpm install");
    process.exitCode = 1;

    return;
  }

  const rceditMain = require("rcedit");
  const files = targets();

  if (files.length === 0) {
    console.error("dist 目录里没有可处理的 exe，请先运行 pnpm run dist");
    process.exitCode = 1;

    return;
  }

  for (const file of files) {
    await rceditMain(file, {
      icon: iconPath,
      "version-string": {
        ProductName: "整体校色",
        FileDescription: "整体校色 · 桌面版",
        CompanyName: "humaneater",
        LegalCopyright: `MIT · ${new Date().getFullYear()}`,
        OriginalFilename: path.basename(file),
      },
      "file-version": version,
      "product-version": version,
    });

    console.log(
      `已写入图标与版本：${path.relative(projectRoot, file)}（v${version}）`,
    );
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
