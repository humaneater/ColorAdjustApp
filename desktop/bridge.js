/**
 * 桌面版本地桥接服务。
 *
 * 前端（app.js）是按「同源 + /api/... 绝对路径」写的，所以这里把网页版
 * serve.ps1 提供的东西原样搬到进程内：
 *   - 静态文件：仓库根目录（打包后是 resources/app）里的同一批前端文件；
 *   - /api/comfy/*  与 /api/outputs/*：与 serve.ps1 完全一致的接口契约；
 *   - 响应头带上 COOP/COEP/CORP，libraw-wasm 的多线程才会拿到 SharedArrayBuffer。
 *
 * 只监听 127.0.0.1，端口由系统分配，因此不会和网页版的 8765 冲突。
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { createComfyService } = require("./comfy");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

/** 与 serve.ps1 的 Get-ContentType 保持一致的 MIME 表。 */
function contentTypeFor(filePath) {
  return (
    MIME_TYPES.get(path.extname(filePath).toLowerCase()) ||
    "application/octet-stream"
  );
}

/**
 * 每个响应都带上网页版那套跨源隔离响应头。
 * 少一个，raw 解码就会因为拿不到 SharedArrayBuffer 而失败。
 */
function applyCommonHeaders(res, contentType, contentLength) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(contentLength));
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");

  applyCommonHeaders(res, "application/json; charset=utf-8", body.length);
  res.writeHead(statusCode);
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function sendText(res, statusCode, text, headOnly = false) {
  const body = Buffer.from(text, "utf8");

  applyCommonHeaders(res, "text/plain; charset=utf-8", body.length);
  res.writeHead(statusCode);
  res.end(headOnly ? undefined : body);
}

async function readRequestBody(req, limitBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > limitBytes) {
      throw new Error("请求体过大");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readRequestBody(req, 1024 * 1024);

  if (body.length === 0) {
    return {};
  }

  return JSON.parse(body.toString("utf8"));
}

/** 静态文件：与 serve.ps1 的 Get-StaticResponse 同样的路径规则。 */
async function serveStatic(req, res, webRoot, pathname, headOnly, mounts) {
  let relative = decodeURIComponent(pathname.replace(/^\/+/, "")) || "index.html";
  let root = path.resolve(webRoot);

  // AI 结果保存在图片库里，但前端用的是 /outputs/<文件名>，
  // 这里把该前缀挂到输出目录上，前端就不用改。
  for (const mount of mounts) {
    if (pathname.startsWith(mount.prefix)) {
      root = path.resolve(mount.root);
      relative = decodeURIComponent(
        pathname.slice(mount.prefix.length),
      );
      break;
    }
  }

  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  let fullPath = path.resolve(root, relative);

  if (fullPath !== root && !fullPath.startsWith(rootPrefix)) {
    sendText(res, 403, "Forbidden", headOnly);

    return;
  }

  try {
    const stats = await fsp.stat(fullPath);

    if (stats.isDirectory()) {
      fullPath = path.join(fullPath, "index.html");
    }
  } catch {
    sendText(res, 404, "Not Found", headOnly);

    return;
  }

  let stats;

  try {
    stats = await fsp.stat(fullPath);
  } catch {
    sendText(res, 404, "Not Found", headOnly);

    return;
  }

  if (!stats.isFile()) {
    sendText(res, 404, "Not Found", headOnly);

    return;
  }

  applyCommonHeaders(res, contentTypeFor(fullPath), stats.size);
  res.writeHead(200);

  if (headOnly) {
    res.end();

    return;
  }

  await new Promise((resolve) => {
    const stream = fs.createReadStream(fullPath);

    stream.on("error", () => {
      res.destroy();
      resolve();
    });
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

function createBridgeServer(options) {
  const webRoot = path.resolve(options.webRoot);
  const outputDir = path.resolve(options.outputDir);
  const log = options.log || (() => {});
  const mounts = [{ prefix: "/outputs/", root: outputDir }];
  const comfy = createComfyService({
    webRoot,
    outputDir,
    log,
    decodeMaskPixels: options.decodeMaskPixels,
    revealFile: options.revealFile,
    defaultRoots: options.defaultRoots,
  });

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      log(`请求处理失败：${error?.stack || error}`);

      if (res.headersSent) {
        res.destroy();

        return;
      }

      sendError(res, 500, error?.message || String(error));
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;
    const headOnly = req.method === "HEAD";

    if (pathname.startsWith("/api/comfy/")) {
      try {
        await comfy.handleApi(req, res, pathname, { sendJson, sendError });
      } catch (error) {
        sendError(res, 500, error?.message || String(error));
      }

      return;
    }

    if (pathname.startsWith("/api/outputs/")) {
      try {
        await handleOutputApi(req, res, pathname);
      } catch (error) {
        sendError(res, 500, error?.message || String(error));
      }

      return;
    }

    if (req.method !== "GET" && !headOnly) {
      sendError(res, 405, "Method not allowed.");

      return;
    }

    await serveStatic(req, res, webRoot, pathname, headOnly, mounts);
  }

  async function handleOutputApi(req, res, pathname) {
    if (pathname === "/api/outputs/reveal" && req.method === "POST") {
      const payload = await readJsonBody(req);
      const resolved = comfy.resolveOutputPath(payload?.path);

      if (!resolved) {
        throw new Error("The output path is outside the outputs directory.");
      }

      if (!fs.existsSync(resolved)) {
        throw new Error("The output file no longer exists.");
      }

      await comfy.revealInExplorer(resolved);
      sendJson(res, 200, { ok: true, path: resolved });

      return;
    }

    sendError(res, 404, "Unknown bridge endpoint.");
  }

  return {
    comfy,
    server,

    /** 监听 127.0.0.1 的随机空闲端口，返回实际端口号。 */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },

    close() {
      comfy.dispose();

      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

module.exports = {
  createBridgeServer,
  contentTypeFor,
  MIME_TYPES,
};
