/**
 * ComfyUI 桥接：serve.ps1 里 /api/comfy/* 的 Node 移植。
 *
 * 移植目标是「接口契约完全一致」——前端 app.js 是照这套契约写的，错误文案还会被
 * 精确匹配成中文提示（见 app.js 的 AI_ERROR_MESSAGES），所以这里连状态码
 * （校验失败一律 500，而不是 400）和文案都照搬。
 *
 * 与 PowerShell 版的两处有意差异：
 *   1. 请求并发处理，不再一个连接一个连接地排队（原来的实现里，启动 ComfyUI 的
 *      90 秒会卡住整个服务）；
 *   2. 只监听 127.0.0.1 的随机端口，且没有控制台输出。
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 8188;
const PROBE_TIMEOUT_MS = 350;
const START_TIMEOUT_MS = 90000;
const START_POLL_MS = 250;
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const IDLE_TICK_MS = 30 * 1000;
const JOB_EXPIRY_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 120000;
const TRANSFER_TIMEOUT_MS = 180000;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const CHECKPOINT_EXTENSIONS = new Set([".safetensors", ".ckpt", ".pt", ".pth"]);
const SAM_EXTENSIONS = new Set([".pt", ".pth", ".safetensors"]);
const MAX_OUTPUT_NAME_LENGTH = 140;
const DEFAULT_SAM_NAME = "sam_vit_b_01ec64.pth";
const APP_DATA_DIR_NAME = "ColorAdjustApp";

/* ------------------------------ 小工具 ------------------------------ */

function readJsonFileSync(filePath) {
  // PS 版写入的是带 BOM 的 UTF-8，读的时候要容忍
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");

  return JSON.parse(text);
}

function listFiles(directory, { recursive = false } = {}) {
  const results = [];

  const walk = (current) => {
    let entries;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (recursive) {
          walk(full);
        }

        continue;
      }

      if (entry.isFile()) {
        results.push(full);
      }
    }
  };

  walk(directory);

  return results;
}

function listDirectories(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 与 PowerShell 的 -contains / -notcontains 一样不区分大小写。 */
function containsIgnoreCase(values, target) {
  const needle = String(target).toLowerCase();

  return values.some((value) => String(value).toLowerCase() === needle);
}

function sortNames(values) {
  // PS 的 Sort-Object 是文化相关的忽略大小写排序；文件名多为 ASCII，
  // 这里用忽略大小写比较 + 原始字符串兜底，保证顺序稳定可复现。
  return Array.from(new Set(values)).sort((left, right) => {
    const folded = left.toLowerCase().localeCompare(right.toLowerCase());

    return folded !== 0 ? folded : left.localeCompare(right);
  });
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function randomSeed() {
  return crypto.randomInt(0, 2147483647);
}

/* ------------------------------ 服务主体 ------------------------------ */

/** 保证 127.0.0.1 / localhost 不走系统代理。 */
function ensureLoopbackBypassesProxy() {
  const hasProxy = Boolean(
    process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy,
  );

  if (!hasProxy) {
    return;
  }

  for (const name of ["NO_PROXY", "no_proxy"]) {
    const current = process.env[name] || "";
    const entries = current
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    for (const needed of ["127.0.0.1", "localhost", "::1"]) {
      if (!entries.includes(needed)) {
        entries.push(needed);
      }
    }

    process.env[name] = entries.join(",");
  }
}

function createComfyService(options) {
  const webRoot = path.resolve(options.webRoot);
  const outputDir = path.resolve(options.outputDir);
  const log = options.log || (() => {});

  // 本机回环不应该走代理：有些环境设了 HTTP(S)_PROXY 又开了 NODE_USE_ENV_PROXY，
  // 一旦 NO_PROXY 里没有 127.0.0.1，访问 ComfyUI 就会被转发到代理上。
  ensureLoopbackBypassesProxy();
  const appDataDir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    APP_DATA_DIR_NAME,
  );
  const comfyConfigPath = path.join(appDataDir, "comfy.json");
  const temporaryDir = path.join(os.tmpdir(), APP_DATA_DIR_NAME);
  const workflowPath = path.join(webRoot, "comfy", "PortraitApi.json");

  /** jobId → job 记录，和 PS 版一样只放在内存里。 */
  const jobs = new Map();
  /** 由本进程启动的 ComfyUI（外部已在运行的一律不管）。 */
  let managedChild = null;
  let lastManagedActivity = Date.now();

  /* ---------------------- 配置与安装目录 ---------------------- */

  function defaultCandidates() {
    // 允许调用方覆盖（测试里用空列表关掉自动探测）
    if (Array.isArray(options.defaultRoots)) {
      return options.defaultRoots;
    }

    return [
      process.env.COMFYUI_ROOT,
      "D:\\AI\\ComfyUI",
      "D:\\ComfyUI",
      path.join(os.homedir(), "ComfyUI"),
      path.join(os.homedir(), "Documents", "ComfyUI"),
    ].filter(Boolean);
  }

  /** 每次都重新读配置，改完立刻生效（与 PS 版一致，也不做缓存）。 */
  function getComfyConfig() {
    let root = "";
    let port = DEFAULT_PORT;

    try {
      if (fs.existsSync(comfyConfigPath)) {
        const parsed = readJsonFileSync(comfyConfigPath);

        if (parsed && typeof parsed.root === "string" && parsed.root.trim()) {
          root = parsed.root;
        }

        if (parsed && Number(parsed.port)) {
          port = Number(parsed.port);
        }
      }
    } catch {
      root = "";
      port = DEFAULT_PORT;
    }

    if (!root) {
      for (const candidate of defaultCandidates()) {
        const resolved = resolveComfyInstall(candidate);

        if (resolved.valid) {
          root = resolved.root;
          break;
        }
      }
    }

    return { root, port };
  }

  function saveComfyConfig(root, port) {
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.writeFileSync(
      comfyConfigPath,
      `${JSON.stringify({ root, port }, null, 4)}\n`,
      "utf8",
    );
  }

  /** 校验安装目录：必须同时有 ComfyUI\main.py 与 python_embeded\python.exe。 */
  function resolveComfyInstall(installRoot) {
    const empty = {
      valid: false,
      root: "",
      comfyDirectory: "",
      mainPath: "",
      pythonPath: "",
      customNodesDirectory: "",
      modelsDirectory: "",
      tempDirectory: "",
      checkpointsDirectory: "",
      samsDirectory: "",
      detectorPath: "",
      error: "",
    };

    const raw = String(installRoot ?? "").trim().replace(/^"|"$/g, "");

    if (!raw) {
      return { ...empty, error: "ComfyUI path is empty." };
    }

    let root;

    try {
      root = path.resolve(raw);
    } catch {
      return { ...empty, error: "ComfyUI path is invalid." };
    }

    const nestedMain = path.join(root, "ComfyUI", "main.py");
    const flatMain = path.join(root, "main.py");
    const mainPath = fs.existsSync(nestedMain)
      ? nestedMain
      : fs.existsSync(flatMain)
        ? flatMain
        : nestedMain;
    const comfyDirectory = path.dirname(mainPath);
    const nestedPython = path.join(root, "python_embeded", "python.exe");
    const flatPython = path.resolve(
      comfyDirectory,
      "..",
      "python_embeded",
      "python.exe",
    );
    const pythonPath = fs.existsSync(nestedPython) ? nestedPython : flatPython;
    const valid = fs.existsSync(mainPath) && fs.existsSync(pythonPath);

    return {
      valid,
      root,
      comfyDirectory,
      mainPath,
      pythonPath,
      customNodesDirectory: path.join(comfyDirectory, "custom_nodes"),
      modelsDirectory: path.join(comfyDirectory, "models"),
      tempDirectory: path.join(comfyDirectory, "temp"),
      checkpointsDirectory: path.join(comfyDirectory, "models", "checkpoints"),
      samsDirectory: path.join(comfyDirectory, "models", "sams"),
      detectorPath: path.join(
        comfyDirectory,
        "models",
        "ultralytics",
        "bbox",
        "face_yolov8m.pt",
      ),
      error: valid ? "" : "ComfyUI main.py or python_embeded is missing.",
    };
  }

  /* ---------------------- 模型与依赖 ---------------------- */

  function getCheckpointFiles(info) {
    if (!info.valid || !fs.existsSync(info.checkpointsDirectory)) {
      return [];
    }

    const models = [];

    for (const file of listFiles(info.checkpointsDirectory, { recursive: true })) {
      const extension = path.extname(file).toLowerCase();

      if (!CHECKPOINT_EXTENSIONS.has(extension)) {
        continue;
      }

      models.push(path.relative(info.checkpointsDirectory, file));
    }

    return sortNames(models);
  }

  function getSamFiles(info) {
    if (!info.valid || !fs.existsSync(info.samsDirectory)) {
      return [];
    }

    return listFiles(info.samsDirectory)
      .filter((file) => SAM_EXTENSIONS.has(path.extname(file).toLowerCase()))
      .map((file) => path.basename(file));
  }

  /** impact-pack 与 subpack 只看目录名，和 PS 版一致。 */
  function getNodeState(info) {
    if (!info.valid) {
      return {
        impactPack: false,
        impactSubpack: false,
        faceDetector: false,
        sam: false,
      };
    }

    const customNodes = listDirectories(info.customNodesDirectory);

    return {
      impactPack: customNodes.includes("ComfyUI-Impact-Pack"),
      impactSubpack: customNodes.includes("ComfyUI-Impact-Subpack"),
      faceDetector: fs.existsSync(info.detectorPath),
      sam: getSamFiles(info).length > 0,
    };
  }

  /** 优先用官方 sam_vit_b_01ec64.pth，否则按名字取第一个。 */
  function getFirstSamModel(info) {
    const models = sortNames(getSamFiles(info));

    if (models.length === 0) {
      return "";
    }

    return (
      models.find(
        (name) => name.toLowerCase() === DEFAULT_SAM_NAME.toLowerCase(),
      ) || models[0]
    );
  }

  /* ---------------------- ComfyUI 进程 ---------------------- */

  function testComfyPort(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let settled = false;

      const finish = (value) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }

  function isManagedRunning() {
    return Boolean(managedChild && managedChild.exitCode === null);
  }

  function stopManagedComfy() {
    if (!isManagedRunning()) {
      managedChild = null;

      return;
    }

    const child = managedChild;

    managedChild = null;

    try {
      child.kill();
    } catch (error) {
      log(`停止 ComfyUI 失败：${error?.message || error}`);
    }
  }

  async function startComfyService(info, port) {
    if (!info.valid) {
      throw new Error("ComfyUI path is invalid.");
    }

    if (await testComfyPort(port)) {
      return false;
    }

    fs.mkdirSync(temporaryDir, { recursive: true });
    fs.mkdirSync(appDataDir, { recursive: true });

    const stdoutPath = path.join(temporaryDir, "comfyui-stdout.log");
    const stderrPath = path.join(temporaryDir, "comfyui-stderr.log");
    const stdout = fs.openSync(stdoutPath, "a");
    const stderr = fs.openSync(stderrPath, "a");
    const child = spawn(
      info.pythonPath,
      [
        info.mainPath,
        "--listen",
        "127.0.0.1",
        "--port",
        String(port),
        "--disable-auto-launch",
      ],
      {
        cwd: info.comfyDirectory,
        windowsHide: true,
        stdio: ["ignore", stdout, stderr],
        detached: false,
      },
    );

    managedChild = child;
    lastManagedActivity = Date.now();
    log(`已启动 ComfyUI（pid ${child.pid}，端口 ${port}）`);

    const deadline = Date.now() + START_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (await testComfyPort(port)) {
        return true;
      }

      if (child.exitCode !== null) {
        const tail = readLogTail(stderrPath);

        stopManagedComfy();

        throw new Error(`ComfyUI exited during startup. ${tail}`);
      }

      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }

    stopManagedComfy();

    throw new Error("ComfyUI did not become ready within 90 seconds.");
  }

  function readLogTail(filePath) {
    try {
      const text = fs.readFileSync(filePath, "utf8").trim();

      if (!text) {
        return "";
      }

      return text.split(/\r?\n/).slice(-8).join(" ");
    } catch {
      return "";
    }
  }

  async function ensureComfyService(info, port) {
    if (await testComfyPort(port)) {
      return;
    }

    await startComfyService(info, port);
  }

  /* ---------------------- ComfyUI HTTP ---------------------- */

  async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把网络层的异常（含超时）翻译成能看懂的中文提示。 */
  function describeTransportError(error, url) {
    if (error?.name === "AbortError") {
      return `请求 ComfyUI 超时：${url}`;
    }

    const cause = error?.cause?.message || error?.message || String(error);

    return `无法连接 ComfyUI（${url}）：${cause}`;
  }

  async function requestComfyJson(url, { method = "GET", body, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
    let response;

    try {
      response = await fetchWithTimeout(
        url,
        {
          method,
          headers: body ? { "Content-Type": "application/json; charset=utf-8" } : undefined,
          body,
        },
        timeoutMs,
      );
    } catch (error) {
      throw new Error(describeTransportError(error, url));
    }

    const text = await response.text();

    if (!response.ok) {
      // ComfyUI 的节点校验失败会返回 4xx，把它的原始信息带出来
      let detail = text;

      try {
        const parsed = JSON.parse(text);

        detail = parsed?.error?.message || parsed?.error || text;
      } catch {
        // 保持原文
      }

      throw new Error(
        `ComfyUI 返回 ${response.status}：${String(detail).slice(0, 800)}`,
      );
    }

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error("ComfyUI 返回了无法解析的 JSON");
    }
  }

  async function postComfyJson(url, payload, timeoutMs) {
    return requestComfyJson(url, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs,
    });
  }

  /* ---------------------- 上传 / 下载 ---------------------- */

  function buildMultipartBody(imageBytes, fileName) {
    const boundary = `----ColorAdjustApp${crypto.randomUUID().replace(/-/g, "")}`;
    const chunks = [];
    const push = (text) => chunks.push(Buffer.from(text, "utf8"));

    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="type"\r\n\r\n');
    push("temp\r\n");
    push(`--${boundary}\r\n`);
    push('Content-Disposition: form-data; name="overwrite"\r\n\r\n');
    push("true\r\n");
    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n`,
    );
    push("Content-Type: image/png\r\n\r\n");
    chunks.push(imageBytes);
    push(`\r\n--${boundary}--\r\n`);

    return { boundary, body: Buffer.concat(chunks) };
  }

  async function uploadComfyImage(port, imageBytes, fileName) {
    const { boundary, body } = buildMultipartBody(imageBytes, fileName);
    const url = `http://127.0.0.1:${port}/upload/image`;
    let response;

    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        },
        TRANSFER_TIMEOUT_MS,
      );
    } catch (error) {
      throw new Error(describeTransportError(error, url));
    }

    if (!response.ok) {
      throw new Error(`ComfyUI 上传失败（${response.status}）`);
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("ComfyUI 返回了无法解析的上传结果");
    }
  }

  async function downloadComfyImage(port, imageInfo, destination) {
    const query = new URLSearchParams({
      filename: String(imageInfo?.filename ?? ""),
      subfolder: String(imageInfo?.subfolder ?? ""),
      type: String(imageInfo?.type ?? "temp"),
    });
    const url = `http://127.0.0.1:${port}/view?${query.toString()}`;
    let response;

    try {
      response = await fetchWithTimeout(url, {}, TRANSFER_TIMEOUT_MS);
    } catch (error) {
      throw new Error(describeTransportError(error, url));
    }

    if (!response.ok) {
      throw new Error(`下载 ComfyUI 结果失败（${response.status}）`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer);
  }

  /** outputs["<nodeId>"].images 里的最后一张。 */
  function getImageInfoFromOutputs(outputs, nodeId) {
    const images = outputs?.[nodeId]?.images;

    if (!Array.isArray(images) || images.length === 0) {
      return null;
    }

    return images[images.length - 1];
  }

  function comfyImagePath(info, imageInfo) {
    const subfolder = String(imageInfo?.subfolder ?? "");

    return path.join(
      info.tempDirectory,
      subfolder,
      String(imageInfo?.filename ?? ""),
    );
  }

  /* ---------------------- 工作流 ---------------------- */

  function buildWorkflow(info, { model, inputName, beautify, detailRetention }) {
    if (!fs.existsSync(workflowPath)) {
      throw new Error("Portrait workflow template is missing.");
    }

    let template;

    try {
      template = JSON.parse(
        fs.readFileSync(workflowPath, "utf8").replace(/^\uFEFF/, ""),
      );
    } catch (error) {
      throw new Error(`人像工作流模板无法解析：${error?.message || error}`);
    }

    const samModel = getFirstSamModel(info);

    if (!samModel) {
      throw new Error("No SAM model was found in ComfyUI models\\sams.");
    }

    if (!fs.existsSync(info.detectorPath)) {
      throw new Error("face_yolov8m.pt was not found in ComfyUI models.");
    }

    const denoise = 0.2 + 0.45 * beautify;
    const blend = Math.min(
      1,
      Math.max(0, (0.35 + 0.65 * beautify) * (1.0 - 0.25 * detailRetention)),
    );

    if (denoise < 0.0001 || denoise > 1.0) {
      throw new Error("Beautify strength produced an out-of-range denoise value.");
    }

    const required = ["1", "2", "5", "6", "7", "8"];

    for (const nodeId of required) {
      if (!template[nodeId]?.inputs) {
        throw new Error(`人像工作流模板缺少节点 ${nodeId}。`);
      }
    }

    template["1"].inputs.image = `${inputName} [temp]`;
    template["2"].inputs.ckpt_name = model;
    template["5"].inputs.model_name = "bbox/face_yolov8m.pt";
    template["6"].inputs.model_name = samModel;
    template["7"].inputs.bbox_crop_factor = 2.0;
    template["7"].inputs.seed = randomSeed();
    template["7"].inputs.denoise = round4(denoise);
    template["8"].inputs.blend_factor = round4(blend);

    return template;
  }

  /* ---------------------- 输出文件名 ---------------------- */

  const INVALID_FILE_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

  function safeOutputFileName(requestedName, jobId) {
    let base = path.basename(String(requestedName || "").trim());

    if (!base) {
      base = `ColorAdjustAI-${jobId}.png`;
    }

    let cleaned = "";

    for (const char of base) {
      const code = char.codePointAt(0);

      cleaned +=
        INVALID_FILE_CHARS.has(char) || code < 32 ? "_" : char;
    }

    cleaned = cleaned.trim().replace(/\.+$/, "");

    if (!cleaned) {
      cleaned = `ColorAdjustAI-${jobId}`;
    }

    if (!cleaned.toLowerCase().endsWith(".png")) {
      cleaned += ".png";
    }

    if (cleaned.length > MAX_OUTPUT_NAME_LENGTH) {
      cleaned = `${cleaned.slice(0, MAX_OUTPUT_NAME_LENGTH - 4)}.png`;
    }

    return cleaned;
  }

  function findFreeOutputPath(fileName) {
    const extension = path.extname(fileName);
    const stem = fileName.slice(0, fileName.length - extension.length);
    let candidate = path.join(outputDir, fileName);
    let index = 2;

    while (fs.existsSync(candidate)) {
      candidate = path.join(outputDir, `${stem}-${index}${extension}`);
      index += 1;
    }

    return candidate;
  }

  function saveJobOutput(job) {
    if (!job.resultPath || !fs.existsSync(job.resultPath)) {
      throw new Error("The AI result file is missing.");
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const fileName = safeOutputFileName(job.outputName, job.id);
    const target = findFreeOutputPath(fileName);

    fs.copyFileSync(job.resultPath, target, fs.constants.COPYFILE_EXCL);
    job.savedPath = target;
    job.resultUrl = `/outputs/${encodeURIComponent(path.basename(target))}`;
  }

  /* ---------------------- 任务生命周期 ---------------------- */

  function jobPayload(job) {
    return {
      id: job.id,
      state: job.state,
      progress: Math.round(job.progress),
      error: job.error,
      savedPath: job.savedPath,
      resultUrl: job.resultUrl,
    };
  }

  function removeSafeFile(filePath) {
    if (!filePath) {
      return;
    }

    const allowedPrefixes = [
      temporaryDir.endsWith(path.sep) ? temporaryDir : temporaryDir + path.sep,
    ];

    const config = getComfyConfig();
    const info = resolveComfyInstall(config.root);

    if (info.valid) {
      const tempPrefix =
        info.tempDirectory.endsWith(path.sep)
          ? info.tempDirectory
          : info.tempDirectory + path.sep;

      allowedPrefixes.push(tempPrefix);
    }

    const resolved = path.resolve(filePath);
    const allowed = allowedPrefixes.some((prefix) =>
      resolved.toLowerCase().startsWith(prefix.toLowerCase()),
    );

    if (!allowed) {
      return;
    }

    try {
      fs.rmSync(resolved, { force: true });
    } catch (error) {
      log(`删除临时文件失败：${resolved}（${error?.message || error}）`);
    }
  }

  function cleanupJobFiles(job, { keepResult = false } = {}) {
    removeSafeFile(job.localUploadPath);
    removeSafeFile(job.comfyUploadPath);
    removeSafeFile(job.maskPath);
    removeSafeFile(job.comfyMaskPath);
    removeSafeFile(job.comfyResultPath);

    if (!keepResult) {
      removeSafeFile(job.resultPath);
    }
  }

  function setProgress(job, value) {
    job.progress = Math.max(Number(job.progress) || 0, value);
  }

  /** 灰度阈值判定：遮罩里只要有明显亮起的像素就认为检测到了人脸。 */
  function maskContainsFace(maskPath) {
    if (!maskPath || !fs.existsSync(maskPath)) {
      return true;
    }

    if (typeof options.decodeMaskPixels !== "function") {
      // 没有解码器时按「假设有人脸」处理，和 PS 版异常分支一致
      return true;
    }

    try {
      const pixels = options.decodeMaskPixels(maskPath);

      if (!pixels) {
        return true;
      }

      const { data, width, height, channels } = pixels;
      const step = Math.max(1, Math.floor(width / 160));

      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const offset = (y * width + x) * channels;

          if (
            data[offset] > 8 ||
            data[offset + 1] > 8 ||
            data[offset + 2] > 8
          ) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      log(`遮罩检查失败：${error?.message || error}`);

      return true;
    }
  }

  async function updateJobState(job, config, info) {
    if (["succeeded", "failed", "cancelled", "no_face"].includes(job.state)) {
      return;
    }

    job.updatedAt = Date.now();

    if (!(await testComfyPort(config.port))) {
      job.state = "failed";
      job.error = "ComfyUI stopped while the task was running.";
      cleanupJobFiles(job);

      return;
    }

    try {
      const history = await requestComfyJson(
        `http://127.0.0.1:${config.port}/history/${job.promptId}`,
      );
      const record = history?.[job.promptId];

      if (record) {
        const statusText = String(record?.status?.status_str ?? "");

        if (statusText === "error") {
          job.state = "failed";
          job.error = "ComfyUI reported an execution error.";
          cleanupJobFiles(job);

          return;
        }

        if (statusText === "success") {
          const outputs = record.outputs || {};
          const maskInfo = getImageInfoFromOutputs(outputs, "10");
          const resultInfo = getImageInfoFromOutputs(outputs, "11");

          if (!resultInfo) {
            job.state = "failed";
            job.error = "ComfyUI completed without an output image.";
            cleanupJobFiles(job);

            return;
          }

          if (maskInfo) {
            job.maskPath = path.join(temporaryDir, `mask-${job.id}.png`);
            await downloadComfyImage(config.port, maskInfo, job.maskPath);
            job.comfyMaskPath = comfyImagePath(info, maskInfo);
          }

          job.resultPath = path.join(temporaryDir, `result-${job.id}.png`);
          await downloadComfyImage(config.port, resultInfo, job.resultPath);
          job.comfyResultPath = comfyImagePath(info, resultInfo);

          if (job.maskPath && !maskContainsFace(job.maskPath)) {
            job.state = "no_face";
            job.progress = 100;
            job.updatedAt = Date.now();
            cleanupJobFiles(job);

            return;
          }

          saveJobOutput(job);
          job.state = "succeeded";
          job.progress = 100;
          job.updatedAt = Date.now();
          cleanupJobFiles(job, { keepResult: true });

          return;
        }
      }

      const queue = await requestComfyJson(
        `http://127.0.0.1:${config.port}/queue`,
      );
      const runningIds = (queue?.queue_running || []).map((entry) =>
        String(entry?.[1] ?? ""),
      );

      if (runningIds.includes(String(job.promptId))) {
        job.state = "running";
        setProgress(job, 45);
      } else {
        job.state = "queued";
        setProgress(job, 25);
      }
    } catch (error) {
      job.state = "failed";
      job.error = error?.message || String(error);
      cleanupJobFiles(job);
    }
  }

  async function cancelJobState(job, config) {
    if (["succeeded", "failed", "cancelled", "no_face"].includes(job.state)) {
      return;
    }

    try {
      if (job.promptId && (await testComfyPort(config.port))) {
        const queue = await requestComfyJson(
          `http://127.0.0.1:${config.port}/queue`,
        );
        const ids = [
          ...(queue?.queue_running || []),
          ...(queue?.queue_pending || []),
        ].map((entry) => String(entry?.[1] ?? ""));
        const running = (queue?.queue_running || []).some(
          (entry) => String(entry?.[1] ?? "") === String(job.promptId),
        );

        if (running) {
          await postComfyJson(
            `http://127.0.0.1:${config.port}/interrupt`,
            {},
          );
        }

        if (ids.includes(String(job.promptId))) {
          await postComfyJson(`http://127.0.0.1:${config.port}/queue`, {
            delete: [job.promptId],
          });
        }
      }
    } catch (error) {
      log(`中断 ComfyUI 任务 ${job.id} 失败：${error?.message || error}`);
    }

    job.state = "cancelled";
    cleanupJobFiles(job);
  }

  async function submitJob({ imageBytes, model, beautify, detailRetention, outputName }) {
    const config = getComfyConfig();
    const info = resolveComfyInstall(config.root);

    if (!info.valid) {
      throw new Error("ComfyUI is not configured.");
    }

    const availableModels = getCheckpointFiles(info);

    if (!containsIgnoreCase(availableModels, model)) {
      throw new Error("The selected checkpoint is not available.");
    }

    await ensureComfyService(info, config.port);

    const jobId = crypto.randomUUID().replace(/-/g, "");
    const localUploadPath = path.join(temporaryDir, `upload-${jobId}.png`);

    fs.mkdirSync(temporaryDir, { recursive: true });
    fs.writeFileSync(localUploadPath, imageBytes);

    const job = {
      id: jobId,
      state: "uploading",
      progress: 5,
      error: "",
      promptId: "",
      model,
      beautify,
      detailRetention,
      outputName,
      localUploadPath,
      comfyUploadPath: "",
      comfyResultPath: "",
      comfyMaskPath: "",
      maskPath: "",
      resultPath: "",
      savedPath: "",
      resultUrl: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    jobs.set(jobId, job);

    try {
      const uploadName = `ColorAdjustApp_${jobId}.png`;
      const upload = await uploadComfyImage(config.port, imageBytes, uploadName);
      const uploadedName = String(upload?.name ?? "");
      const uploadedSubfolder = String(upload?.subfolder ?? "");

      if (!uploadedName.trim()) {
        throw new Error("ComfyUI did not return an uploaded image name.");
      }

      job.comfyUploadPath = comfyImagePath(info, {
        filename: uploadedName,
        subfolder: uploadedSubfolder,
        type: "temp",
      });

      const workflow = buildWorkflow(info, {
        model,
        inputName: uploadedName,
        beautify,
        detailRetention,
      });
      const promptResponse = await postComfyJson(
        `http://127.0.0.1:${config.port}/prompt`,
        {
          prompt: workflow,
          client_id: `ColorAdjustApp_${jobId}`,
        },
      );

      if (!promptResponse?.prompt_id) {
        throw new Error("ComfyUI did not accept the workflow.");
      }

      job.promptId = String(promptResponse.prompt_id);
      job.state = "queued";
      job.progress = 20;
      job.updatedAt = Date.now();
      removeSafeFile(localUploadPath);

      return job;
    } catch (error) {
      job.state = "failed";
      job.error = error?.message || String(error);
      cleanupJobFiles(job);

      throw error;
    }
  }

  function cleanupExpiredJobs() {
    const now = Date.now();

    for (const [jobId, job] of jobs) {
      if (
        ["succeeded", "failed", "cancelled", "no_face"].includes(job.state) &&
        now - job.updatedAt >= JOB_EXPIRY_MS
      ) {
        cleanupJobFiles(job);
        jobs.delete(jobId);
      }
    }
  }

  function hasActiveJobs() {
    for (const job of jobs.values()) {
      if (["uploading", "queued", "running"].includes(job.state)) {
        return true;
      }
    }

    return false;
  }

  /** 十分钟没人用就关掉「自己启动的」ComfyUI，外部起的从不碰。 */
  function stopIdleManagedComfy() {
    if (hasActiveJobs() || !isManagedRunning()) {
      return;
    }

    if (Date.now() - lastManagedActivity >= IDLE_SHUTDOWN_MS) {
      log("ComfyUI 空闲十分钟，关闭由本程序启动的进程");
      stopManagedComfy();
    }
  }

  const idleTimer = setInterval(() => {
    stopIdleManagedComfy();
    cleanupExpiredJobs();
  }, IDLE_TICK_MS);

  idleTimer.unref?.();

  /* ---------------------- API ---------------------- */

  function statusPayload() {
    const config = getComfyConfig();
    const info = resolveComfyInstall(config.root);

    return {
      valid: info.valid,
      root: info.root,
      port: config.port,
      online: false,
      managed: isManagedRunning(),
      nodes: getNodeState(info),
      models: getCheckpointFiles(info),
      error: info.error,
    };
  }

  async function handleApi(req, res, pathname, helpers) {
    const { sendJson, sendError } = helpers;
    const method = req.method === "HEAD" ? "GET" : req.method;

    if (pathname === "/api/comfy/status" && method === "GET") {
      const payload = statusPayload();

      payload.online = await testComfyPort(payload.port);
      sendJson(res, 200, payload);

      return;
    }

    if (pathname === "/api/comfy/config" && method === "POST") {
      const payload = await readJson(req);
      const installRoot = String(payload?.root ?? "");
      const comfyPort = Number(payload?.port);

      if (!Number.isFinite(comfyPort) || comfyPort < 1 || comfyPort > 65535) {
        throw new Error("ComfyUI port must be between 1 and 65535.");
      }

      const resolved = resolveComfyInstall(installRoot);

      if (!resolved.valid) {
        throw new Error(
          "The folder does not contain ComfyUI\\main.py and python_embeded\\python.exe.",
        );
      }

      saveComfyConfig(resolved.root, Math.round(comfyPort));

      const status = statusPayload();

      status.online = await testComfyPort(status.port);
      sendJson(res, 200, status);

      return;
    }

    if (pathname === "/api/comfy/models" && method === "GET") {
      const config = getComfyConfig();
      const info = resolveComfyInstall(config.root);

      if (!info.valid) {
        throw new Error("ComfyUI is not configured.");
      }

      const models = getCheckpointFiles(info);

      sendJson(res, 200, { models, model: models[0] || "" });

      return;
    }

    if (pathname === "/api/comfy/jobs" && method === "POST") {
      const body = await readBody(req, MAX_UPLOAD_BYTES);

      if (body.length === 0) {
        throw new Error("The uploaded image is empty.");
      }

      const model = decodeHeader(req.headers["x-coloradjust-model"], "");
      const outputName = decodeHeader(
        req.headers["x-coloradjust-output-name"],
        "",
      );
      const beautify = parseNumberHeader(
        req.headers["x-coloradjust-beautify"],
        0.5,
      );
      const detail = parseNumberHeader(
        req.headers["x-coloradjust-detail"],
        0,
      );

      if (!model.trim()) {
        throw new Error("No portrait checkpoint was selected.");
      }

      const job = await submitJob({
        imageBytes: body,
        model,
        beautify: Math.min(1, Math.max(0, beautify)),
        detailRetention: Math.min(1, Math.max(0, detail)),
        outputName,
      });

      lastManagedActivity = Date.now();
      sendJson(res, 202, jobPayload(job));

      return;
    }

    const jobMatch = /^\/api\/comfy\/jobs\/([0-9a-f]{32})(\/result)?$/.exec(
      pathname,
    );

    if (jobMatch) {
      const jobId = jobMatch[1];
      const wantsResult = Boolean(jobMatch[2]);
      const job = jobs.get(jobId);

      if (!job) {
        throw new Error("Task not found.");
      }

      const config = getComfyConfig();
      const info = resolveComfyInstall(config.root);

      if (wantsResult) {
        if (method !== "GET") {
          sendError(res, 405, "Method not allowed.");

          return;
        }

        await updateJobState(job, config, info);
        lastManagedActivity = Date.now();

        if (job.state !== "succeeded") {
          throw new Error("The task result is not ready.");
        }

        if (!job.resultPath || !fs.existsSync(job.resultPath)) {
          throw new Error("The task result file is missing.");
        }

        const buffer = fs.readFileSync(job.resultPath);

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", String(buffer.length));
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.writeHead(200);
        res.end(buffer);

        return;
      }

      if (method === "GET") {
        await updateJobState(job, config, info);
        lastManagedActivity = Date.now();
        sendJson(res, 200, jobPayload(job));

        return;
      }

      if (method === "DELETE") {
        let payload = jobPayload(job);

        if (["succeeded", "failed", "cancelled", "no_face"].includes(job.state)) {
          cleanupJobFiles(job);
          jobs.delete(jobId);
        } else {
          await cancelJobState(job, config);
          payload = jobPayload(job);
        }

        sendJson(res, 200, payload);

        return;
      }

      sendError(res, 405, "Method not allowed.");

      return;
    }

    sendError(res, 404, "Unknown bridge endpoint.");
  }

  /* ---------------------- 请求体/头部辅助 ---------------------- */

  function readBody(req, limitBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;

      req.on("data", (chunk) => {
        total += chunk.length;

        if (total > limitBytes) {
          reject(new Error("上传的图片过大"));

          return;
        }

        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", (error) => reject(error));
    });
  }

  async function readJson(req) {
    const body = await readBody(req, 4 * 1024 * 1024);

    if (body.length === 0) {
      return {};
    }

    return JSON.parse(body.toString("utf8"));
  }

  function decodeHeader(value, fallback) {
    if (typeof value !== "string" || !value) {
      return fallback;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function parseNumberHeader(value, fallback) {
    if (typeof value !== "string" || !value.trim()) {
      return fallback;
    }

    const parsed = Number.parseFloat(value);

    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /** 只允许处理 outputs 目录里的文件（和 PS 版的前缀校验一致）。 */
  function resolveOutputPath(targetPath) {
    const raw = String(targetPath ?? "").trim();

    if (!raw) {
      throw new Error("The output path is empty.");
    }

    const resolved = path.resolve(raw);
    const prefix = outputDir.endsWith(path.sep)
      ? outputDir
      : outputDir + path.sep;

    if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) {
      return null;
    }

    return resolved;
  }

  function revealInExplorer(filePath) {
    // 桌面版默认用资源管理器选中文件；测试里可以注入一个假的实现
    if (typeof options.revealFile === "function") {
      return Promise.resolve(options.revealFile(filePath));
    }

    const child = spawn("explorer.exe", [`/select,"${filePath}"`], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    let settled = false;

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        log(`打开资源管理器失败：${error?.message || error}`);
      }
    });

    child.unref();

    return Promise.resolve();
  }

  return {
    appDataDir,
    comfyConfigPath,
    temporaryDir,
    outputDir,
    workflowPath,
    jobs,
    handleApi,
    resolveOutputPath,
    revealInExplorer,
    getComfyConfig,
    resolveComfyInstall,
    getCheckpointFiles,
    getNodeState,
    getFirstSamModel,
    buildWorkflow,
    safeOutputFileName,

    dispose() {
      clearInterval(idleTimer);
      stopManagedComfy();
    },
  };
}

module.exports = { createComfyService };
