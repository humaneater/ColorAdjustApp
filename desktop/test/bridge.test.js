/**
 * 桌面版桥接服务的回归测试（纯 Node，不需要 Electron，也不需要真的 ComfyUI）。
 *
 * 做法：临时造一个「ComfyUI 安装目录」，再用一个 mock ComfyUI 服务顶替 8188，
 * 然后把整条链路跑一遍：
 *   静态文件 → 配置检测 → 模型列表 → 提交任务（校验工作流补丁）→ 轮询状态 →
 *   下载结果 → 归档到输出目录 → /outputs 静态访问 → /result → 取消/删除。
 *
 * 运行：node desktop/test/bridge.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "ca-bridge-test-"));

// 必须在 require bridge 之前改环境变量：服务创建时就会读它们
process.env.LOCALAPPDATA = path.join(TEMP_BASE, "AppData");
process.env.TEMP = path.join(TEMP_BASE, "Temp");
process.env.TMP = process.env.TEMP;
process.env.COMFYUI_ROOT = "";

const { createBridgeServer } = require("../bridge");
const { createComfyService } = require("../comfy");

let passed = 0;
const failures = [];

function test(name, run) {
  try {
    run();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

async function testAsync(name, run) {
  try {
    await run();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

function check(name, condition, detail) {
  if (!condition) {
    throw new Error(detail ? `${name}：${detail}` : name);
  }
}

/* --------------------------- 假 ComfyUI 安装目录 --------------------------- */

function buildFakeInstall(baseDir) {
  const root = path.join(baseDir, "ComfyUI-Install");
  const comfy = path.join(root, "ComfyUI");

  fs.mkdirSync(path.join(comfy, "models", "checkpoints", "anime"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(comfy, "models", "sams"), { recursive: true });
  fs.mkdirSync(path.join(comfy, "models", "ultralytics", "bbox"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(comfy, "custom_nodes", "ComfyUI-Impact-Pack"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(comfy, "custom_nodes", "ComfyUI-Impact-Subpack"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(comfy, "temp"), { recursive: true });
  fs.mkdirSync(path.join(root, "python_embeded"), { recursive: true });

  fs.writeFileSync(path.join(comfy, "main.py"), "# fake\n");
  fs.writeFileSync(path.join(root, "python_embeded", "python.exe"), "");
  fs.writeFileSync(
    path.join(comfy, "models", "sams", "sam_vit_b_01ec64.pth"),
    "",
  );
  fs.writeFileSync(
    path.join(comfy, "models", "ultralytics", "bbox", "face_yolov8m.pt"),
    "",
  );

  const models = [
    "27DSmoothAnimeXL_v02.safetensors",
    "anime\\counterfeitV30.safetensors",
  ];

  for (const model of models) {
    fs.writeFileSync(path.join(comfy, "models", "checkpoints", model), "");
  }

  return { root, comfy, models };
}

/* ------------------------------ Mock ComfyUI ------------------------------ */

function createMockComfy() {
  const state = {
    behavior: "success",
    uploads: [],
    prompts: [],
    promptCounter: 0,
    interrupted: false,
    deleted: [],
    maskIsBlank: false,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (payload, status = 200) => {
        const text = JSON.stringify(payload);

        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
        });
        res.end(text);
      };

      if (url.pathname === "/upload/image") {
        const text = body.toString("latin1");
        const name = /filename="([^"]+)"/.exec(text)?.[1] || "";

        state.uploads.push({ name, size: body.length });
        json({ name, subfolder: "", type: "temp" });

        return;
      }

      if (url.pathname === "/prompt") {
        const payload = JSON.parse(body.toString("utf8"));

        state.promptCounter += 1;
        state.prompts.push(payload);
        json({ prompt_id: `prompt${state.promptCounter}` });

        return;
      }

      if (url.pathname === "/queue") {
        if (req.method === "POST") {
          state.deleted.push(JSON.parse(body.toString("utf8")));

          json({});
          return;
        }

        const running =
          state.behavior === "running"
            ? [[0, `prompt${state.promptCounter}`, {}]]
            : [];

        json({ queue_running: running, queue_pending: [] });

        return;
      }

      if (url.pathname === "/interrupt") {
        state.interrupted = true;
        json({});

        return;
      }

      if (url.pathname.startsWith("/history/")) {
        const promptId = url.pathname.split("/").pop();

        // 还在排队 / 正在跑的时候 ComfyUI 的 history 里没有这条记录
        if (state.behavior === "queued" || state.behavior === "running") {
          json({});
          return;
        }

        if (state.behavior === "error") {
          json({ [promptId]: { status: { status_str: "error" } } });
          return;
        }

        if (state.behavior === "noOutput") {
          json({ [promptId]: { status: { status_str: "success" }, outputs: {} } });
          return;
        }

        json({
          [promptId]: {
            status: { status_str: "success" },
            outputs: {
              10: {
                images: [
                  {
                    filename: `mask-${promptId}.png`,
                    subfolder: "",
                    type: "temp",
                  },
                ],
              },
              11: {
                images: [
                  {
                    filename: `result-${promptId}.png`,
                    subfolder: "",
                    type: "temp",
                  },
                ],
              },
            },
          },
        });

        return;
      }

      if (url.pathname === "/view") {
        const filename = url.searchParams.get("filename") || "";
        const payload = filename.startsWith("mask-")
          ? state.maskIsBlank
            ? Buffer.from("blank-mask")
            : Buffer.from("face-mask")
          : Buffer.from("result-image");

        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": payload.length,
        });
        res.end(payload);

        return;
      }

      json({ error: "not found" }, 404);
    });
  });

  return {
    state,
    server,

    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },

    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/* ------------------------------ HTTP 小工具 ------------------------------ */

/** 绕过 fetch 的 URL 归一化，直接写原始请求行。 */
function rawRequest(port, requestLine) {
  const net = require("node:net");

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) }, () => {
      socket.write(
        `${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = "";

    socket.setTimeout(5000);
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(data);
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
  });
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;

  try {
    json = JSON.parse(buffer.toString("utf8"));
  } catch {
    json = null;
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    buffer,
    json,
    text: buffer.toString("utf8"),
  };
}

/* ------------------------------ 测试主体 ------------------------------ */

async function main() {
  const install = buildFakeInstall(TEMP_BASE);
  const mock = createMockComfy();
  const comfyPort = await mock.listen();
  const outputDir = path.join(TEMP_BASE, "Pictures", "ColorAdjustApp");
  const pngBytes = fs.readFileSync(path.join(ROOT, "desktop", "build", "icon.png"));
  const revealCalls = [];

  const bridge = createBridgeServer({
    webRoot: ROOT,
    outputDir,
    log: () => {},
    // 测试里关掉自动探测，保证「未配置」这条路是确定性的
    defaultRoots: [],
    // 测试里不真的去开资源管理器
    revealFile: (filePath) => revealCalls.push(filePath),
    // 遮罩解码在桌面版里由 Electron 的 nativeImage 提供，这里用桩
    decodeMaskPixels: () => ({
      data: mock.state.maskIsBlank ? new Uint8Array([0, 0, 0, 255]) : new Uint8Array([255, 255, 255, 255]),
      width: 1,
      height: 1,
      channels: 4,
    }),
  });

  const port = await bridge.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  process.env.COMFYUI_ROOT = install.root;

  try {
    await runTests({ baseUrl, install, mock, comfyPort, outputDir, pngBytes, revealCalls, bridge });
  } finally {
    await bridge.close();
    await mock.close();
  }
}

async function runTests(context) {
  const { baseUrl, install, mock, comfyPort, outputDir, pngBytes, revealCalls } =
    context;
  const jsonHeaders = { "Content-Type": "application/json" };

  /* ---------------------------- 静态文件 ---------------------------- */

  await testAsync("首页返回 index.html，并带上跨源隔离响应头", async () => {
    const response = await request(baseUrl, "/index.html");

    check("状态码", response.status === 200, String(response.status));
    check(
      "Content-Type",
      response.headers["content-type"] === "text/html; charset=utf-8",
      response.headers["content-type"],
    );
    check(
      "COEP",
      response.headers["cross-origin-embedder-policy"] === "require-corp",
      response.headers["cross-origin-embedder-policy"],
    );
    check(
      "COOP",
      response.headers["cross-origin-opener-policy"] === "same-origin",
      response.headers["cross-origin-opener-policy"],
    );
    check(
      "CORP",
      response.headers["cross-origin-resource-policy"] === "same-origin",
      response.headers["cross-origin-resource-policy"],
    );
    check(
      "nosniff",
      response.headers["x-content-type-options"] === "nosniff",
      response.headers["x-content-type-options"],
    );
    check("内容", response.text.includes("整体校色"));
  });

  await testAsync("脚本按 text/javascript 提供（nosniff 下必须是这个类型）", async () => {
    const response = await request(baseUrl, "/app.js?v=1.0.0");

    check("状态码", response.status === 200, String(response.status));
    check(
      "Content-Type",
      response.headers["content-type"] === "text/javascript; charset=utf-8",
      response.headers["content-type"],
    );
  });

  await testAsync("wasm 按 application/wasm 提供", async () => {
    const response = await request(baseUrl, "/vendor/libraw-wasm/libraw.wasm");

    check("状态码", response.status === 200, String(response.status));
    check(
      "Content-Type",
      response.headers["content-type"] === "application/wasm",
      response.headers["content-type"],
    );
  });

  await testAsync("目录请求回落到 index.html", async () => {
    const response = await request(baseUrl, "/");

    check("状态码", response.status === 200, String(response.status));
    check("内容", response.text.includes("<title>"));
  });

  await testAsync("找不到的文件返回 404 文本", async () => {
    const response = await request(baseUrl, "/nope.txt");

    check("状态码", response.status === 404, String(response.status));
    check("内容", response.text === "Not Found", response.text);
    check(
      "Content-Type",
      response.headers["content-type"] === "text/plain; charset=utf-8",
      response.headers["content-type"],
    );
  });

  await testAsync("越出根目录的路径返回 403", async () => {
    // 说明：URL 解析会先把 /../ 归一化掉，所以路径穿越真正能打到服务端的形态
    // 是「绝对路径」这一类；serve.ps1 与本地桥接都用同一套前缀校验拦它。
    const absolute = await request(baseUrl, "/C:/Windows/win.ini");

    check("状态码", absolute.status === 403, String(absolute.status));
    check("内容", absolute.text === "Forbidden", absolute.text);
  });

  await testAsync("原始套接字里的 .. 也不会读到仓库外的文件", async () => {
    const response = await rawRequest(
      new URL(baseUrl).port,
      "GET /../../../../Windows/win.ini HTTP/1.1",
    );

    check(
      "没有发出 Windows 目录的内容",
      !response.includes("[fonts]") && !response.includes("[extensions]"),
      response.slice(0, 200),
    );
  });

  await testAsync("非 GET/HEAD 的静态请求返回 405 JSON", async () => {
    const response = await request(baseUrl, "/index.html", { method: "PUT" });

    check("状态码", response.status === 405, String(response.status));
    check("错误文案", response.json?.error === "Method not allowed.", response.text);
  });

  /* ---------------------------- 配置检测 ---------------------------- */

  const statusBefore = await testAsync("未配置时 status 返回 valid=false 并给出错误文案", async () => {
    const response = await request(baseUrl, "/api/comfy/status");

    check("状态码", response.status === 200, String(response.status));
    check("valid", response.json.valid === false, JSON.stringify(response.json));
    check(
      "错误文案",
      response.json.error === "ComfyUI path is empty.",
      response.json.error,
    );
  });

  await testAsync("models 在未配置时报 ComfyUI is not configured.", async () => {
    const response = await request(baseUrl, "/api/comfy/models");

    check("状态码是 500", response.status === 500, String(response.status));
    check(
      "错误文案",
      response.json?.error === "ComfyUI is not configured.",
      response.text,
    );
  });

  await testAsync("端口越界会被拒绝", async () => {
    const response = await request(baseUrl, "/api/comfy/config", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ root: install.root, port: 70000 }),
    });

    check("状态码", response.status === 500, String(response.status));
    check(
      "错误文案",
      response.json?.error === "ComfyUI port must be between 1 and 65535.",
      response.text,
    );
  });

  await testAsync("目录不对会被拒绝", async () => {
    const response = await request(baseUrl, "/api/comfy/config", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ root: path.join(TEMP_BASE, "nope"), port: comfyPort }),
    });

    check("状态码", response.status === 500, String(response.status));
    check(
      "错误文案",
      response.json?.error ===
        "The folder does not contain ComfyUI\\main.py and python_embeded\\python.exe.",
      response.text,
    );
  });

  let savedConfig = null;

  await testAsync("保存配置后 status 里四个依赖都就绪", async () => {
    const response = await request(baseUrl, "/api/comfy/config", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ root: install.root, port: comfyPort }),
    });

    check("状态码", response.status === 200, String(response.status));
    check("valid", response.json.valid === true, JSON.stringify(response.json));
    check(
      "nodes",
      response.json.nodes.impactPack === true &&
        response.json.nodes.impactSubpack === true &&
        response.json.nodes.faceDetector === true &&
        response.json.nodes.sam === true,
      JSON.stringify(response.json.nodes),
    );
    check(
      "models",
      response.json.models.length === 2,
      JSON.stringify(response.json.models),
    );

    savedConfig = response.json;

    const configPath = path.join(
      process.env.LOCALAPPDATA,
      "ColorAdjustApp",
      "comfy.json",
    );

    check("配置文件已写入", fs.existsSync(configPath), configPath);

    const written = JSON.parse(
      fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""),
    );

    check("写入的 root 是绝对路径", written.root === install.root, written.root);
    check("写入的 port", written.port === comfyPort, String(written.port));
  });

  await testAsync("models 返回列表与首选项", async () => {
    const response = await request(baseUrl, "/api/comfy/models");

    check("状态码", response.status === 200, String(response.status));
    check(
      "模型列表",
      response.json.models.length === 2 &&
        response.json.models.includes("27DSmoothAnimeXL_v02.safetensors"),
      JSON.stringify(response.json.models),
    );
    check("默认模型是第一个", response.json.model === response.json.models[0]);
  });

  /* ---------------------------- 任务流程 ---------------------------- */

  await testAsync("空请求体被拒绝", async () => {
    const response = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: { "X-ColorAdjust-Model": "a.safetensors" },
    });

    check("状态码", response.status === 500, String(response.status));
    check(
      "错误文案",
      response.json?.error === "The uploaded image is empty.",
      response.text,
    );
  });

  await testAsync("没选模型被拒绝", async () => {
    const response = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      body: pngBytes,
    });

    check("状态码", response.status === 500, String(response.status));
    check(
      "错误文案",
      response.json?.error === "No portrait checkpoint was selected.",
      response.text,
    );
  });

  await testAsync("模型不在列表里被拒绝", async () => {
    const response = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: { "X-ColorAdjust-Model": encodeURIComponent("not-there.safetensors") },
      body: pngBytes,
    });

    check("状态码", response.status === 500, String(response.status));
    check(
      "错误文案",
      response.json?.error === "The selected checkpoint is not available.",
      response.text,
    );
  });

  let jobId = "";

  await testAsync("提交任务会把工作流补丁打对，并返回 202", async () => {
    mock.state.prompts.length = 0;
    mock.state.uploads.length = 0;

    const response = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-ColorAdjust-Model": encodeURIComponent(
          "27DSmoothAnimeXL_v02.safetensors",
        ),
        "X-ColorAdjust-Beautify": "0.6",
        "X-ColorAdjust-Detail": "0",
        "X-ColorAdjust-Output-Name": encodeURIComponent("IMG_0001-AI.png"),
      },
      body: pngBytes,
    });

    check("状态码是 202", response.status === 202, `${response.status} ${response.text}`);
    check("任务号是 32 位小写十六进制", /^[0-9a-f]{32}$/.test(response.json.id), response.json.id);
    check("初始状态", response.json.state === "queued", response.json.state);
    check("进度", response.json.progress === 20, String(response.json.progress));
    check("payload 字段顺序", JSON.stringify(Object.keys(response.json)) ===
      JSON.stringify(["id", "state", "progress", "error", "savedPath", "resultUrl"]),
      Object.keys(response.json).join(","));

    jobId = response.json.id;

    check("图片已上传给 ComfyUI", mock.state.uploads.length === 1, JSON.stringify(mock.state.uploads));
    check(
      "上传文件名带任务号",
      mock.state.uploads[0].name === `ColorAdjustApp_${jobId}.png`,
      mock.state.uploads[0].name,
    );

    const prompt = mock.state.prompts[0];

    check("prompt 带 client_id", String(prompt.client_id).includes(jobId), prompt.client_id);

    const workflow = prompt.prompt;

    check(
      "节点 1：LoadImage 用上传名 + [temp]",
      workflow["1"].inputs.image === `ColorAdjustApp_${jobId}.png [temp]`,
      workflow["1"].inputs.image,
    );
    check(
      "节点 2：ckpt_name 用请求里的模型",
      workflow["2"].inputs.ckpt_name === "27DSmoothAnimeXL_v02.safetensors",
      workflow["2"].inputs.ckpt_name,
    );
    check(
      "节点 5：检测模型固定 bbox/face_yolov8m.pt",
      workflow["5"].inputs.model_name === "bbox/face_yolov8m.pt",
      workflow["5"].inputs.model_name,
    );
    check(
      "节点 6：SAM 用默认首选模型",
      workflow["6"].inputs.model_name === "sam_vit_b_01ec64.pth",
      workflow["6"].inputs.model_name,
    );
    check(
      "节点 7：bbox_crop_factor 固定 2.0",
      workflow["7"].inputs.bbox_crop_factor === 2.0,
      String(workflow["7"].inputs.bbox_crop_factor),
    );
    check(
      "节点 7：denoise = 0.2 + 0.45 × 0.6",
      workflow["7"].inputs.denoise === 0.47,
      String(workflow["7"].inputs.denoise),
    );
    check(
      "节点 7：seed 是整数",
      Number.isInteger(workflow["7"].inputs.seed),
      String(workflow["7"].inputs.seed),
    );
    check(
      "节点 8：blend = (0.35 + 0.65 × 0.6) × 1",
      workflow["8"].inputs.blend_factor === 0.74,
      String(workflow["8"].inputs.blend_factor),
    );

    // 上传的临时文件应当被清掉
    const uploadTemp = path.join(
      process.env.TEMP,
      "ColorAdjustApp",
      `upload-${jobId}.png`,
    );

    check("上传临时文件已清理", !fs.existsSync(uploadTemp), uploadTemp);
  });

  await testAsync("轮询任务状态返回 running", async () => {
    mock.state.behavior = "running";

    const response = await request(baseUrl, `/api/comfy/jobs/${jobId}`);

    check("状态码", response.status === 200, String(response.status));
    check("状态", response.json.state === "running", response.json.state);
    check("进度", response.json.progress === 45, String(response.json.progress));
  });

  await testAsync("任务完成后给出 savedPath 与 resultUrl", async () => {
    mock.state.behavior = "success";

    const response = await request(baseUrl, `/api/comfy/jobs/${jobId}`);

    check("状态码", response.status === 200, String(response.status));
    check("状态", response.json.state === "succeeded", JSON.stringify(response.json));
    check("进度", response.json.progress === 100, String(response.json.progress));
    check(
      "文件名取自请求头",
      path.basename(response.json.savedPath) === "IMG_0001-AI.png",
      response.json.savedPath,
    );
    check(
      "文件落在输出目录",
      path.dirname(response.json.savedPath) === outputDir,
      response.json.savedPath,
    );
    check(
      "resultUrl 指向 /outputs/",
      response.json.resultUrl === "/outputs/IMG_0001-AI.png",
      response.json.resultUrl,
    );
    check("本地文件已生成", fs.existsSync(response.json.savedPath));
    check(
      "内容就是 ComfyUI 返回的图",
      fs.readFileSync(response.json.savedPath, "utf8") === "result-image",
    );
  });

  await testAsync("/outputs/<文件> 能通过静态路由访问", async () => {
    const response = await request(baseUrl, "/outputs/IMG_0001-AI.png");

    check("状态码", response.status === 200, String(response.status));
    check("内容", response.text === "result-image", response.text);
  });

  await testAsync("同名结果会加 -2 后缀", async () => {
    mock.state.prompts.length = 0;

    const created = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: {
        "X-ColorAdjust-Model": encodeURIComponent("27DSmoothAnimeXL_v02.safetensors"),
        "X-ColorAdjust-Beautify": "0.5",
        "X-ColorAdjust-Output-Name": encodeURIComponent("IMG_0001-AI.png"),
      },
      body: pngBytes,
    });

    const polled = await request(baseUrl, `/api/comfy/jobs/${created.json.id}`);

    check("状态", polled.json.state === "succeeded", JSON.stringify(polled.json));
    check(
      "第二个文件带 -2",
      path.basename(polled.json.savedPath) === "IMG_0001-AI-2.png",
      polled.json.savedPath,
    );

    await request(baseUrl, `/api/comfy/jobs/${created.json.id}`, { method: "DELETE" });
  });

  await testAsync("/result 返回 image/png 原始字节", async () => {
    const response = await request(baseUrl, `/api/comfy/jobs/${jobId}/result`);

    check("状态码", response.status === 200, String(response.status));
    check(
      "Content-Type",
      response.headers["content-type"] === "image/png",
      response.headers["content-type"],
    );
    check("内容", response.buffer.toString("utf8") === "result-image");
  });

  await testAsync("未完成的任务取结果会报 The task result is not ready.", async () => {
    mock.state.behavior = "queued";

    const created = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: {
        "X-ColorAdjust-Model": encodeURIComponent("27DSmoothAnimeXL_v02.safetensors"),
      },
      body: pngBytes,
    });

    const response = await request(baseUrl, `/api/comfy/jobs/${created.json.id}/result`);

    check("状态码", response.status === 500, String(response.status));
    check(
      "错误文案",
      response.json?.error === "The task result is not ready.",
      response.text,
    );

    await request(baseUrl, `/api/comfy/jobs/${created.json.id}`, { method: "DELETE" });
    mock.state.behavior = "success";
  });

  await testAsync("取消任务会把 ComfyUI 队列里的任务删掉", async () => {
    mock.state.behavior = "running";
    mock.state.interrupted = false;
    mock.state.deleted.length = 0;

    const created = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: {
        "X-ColorAdjust-Model": encodeURIComponent("27DSmoothAnimeXL_v02.safetensors"),
      },
      body: pngBytes,
    });

    const cancelled = await request(baseUrl, `/api/comfy/jobs/${created.json.id}`, {
      method: "DELETE",
    });

    check("状态码", cancelled.status === 200, String(cancelled.status));
    check("状态", cancelled.json.state === "cancelled", JSON.stringify(cancelled.json));
    check("已 interrupt", mock.state.interrupted === true);
    check(
      "已从队列删除",
      JSON.stringify(mock.state.deleted) ===
        JSON.stringify([{ delete: [`prompt${mock.state.promptCounter}`] }]),
      JSON.stringify(mock.state.deleted),
    );

    mock.state.behavior = "success";
  });

  await testAsync("删除后的任务查询报 Task not found.", async () => {
    const response = await request(baseUrl, `/api/comfy/jobs/${jobId}`, {
      method: "DELETE",
    });

    check("状态码", response.status === 200, String(response.status));

    const again = await request(baseUrl, `/api/comfy/jobs/${jobId}`);

    check("状态码是 500", again.status === 500, String(again.status));
    check("错误文案", again.json?.error === "Task not found.", again.text);
  });

  await testAsync("未知任务号格式落到 404", async () => {
    const response = await request(baseUrl, "/api/comfy/jobs/not-a-job-id");

    check("状态码", response.status === 404, String(response.status));
    check(
      "错误文案",
      response.json?.error === "Unknown bridge endpoint.",
      response.text,
    );
  });

  await testAsync("ComfyUI 执行失败会报 execution error", async () => {
    mock.state.behavior = "error";

    const created = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: {
        "X-ColorAdjust-Model": encodeURIComponent("27DSmoothAnimeXL_v02.safetensors"),
      },
      body: pngBytes,
    });
    const polled = await request(baseUrl, `/api/comfy/jobs/${created.json.id}`);

    check("状态", polled.json.state === "failed", JSON.stringify(polled.json));
    check(
      "错误文案",
      polled.json.error === "ComfyUI reported an execution error.",
      polled.json.error,
    );

    mock.state.behavior = "success";
  });

  await testAsync("没有输出图会报 completed without an output image", async () => {
    mock.state.behavior = "noOutput";

    const created = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: {
        "X-ColorAdjust-Model": encodeURIComponent("27DSmoothAnimeXL_v02.safetensors"),
      },
      body: pngBytes,
    });
    const polled = await request(baseUrl, `/api/comfy/jobs/${created.json.id}`);

    check("状态", polled.json.state === "failed", JSON.stringify(polled.json));
    check(
      "错误文案",
      polled.json.error === "ComfyUI completed without an output image.",
      polled.json.error,
    );

    mock.state.behavior = "success";
  });

  await testAsync("遮罩全黑时判定为没检测到人脸", async () => {
    mock.state.maskIsBlank = true;

    const created = await request(baseUrl, "/api/comfy/jobs", {
      method: "POST",
      headers: {
        "X-ColorAdjust-Model": encodeURIComponent("27DSmoothAnimeXL_v02.safetensors"),
      },
      body: pngBytes,
    });
    const polled = await request(baseUrl, `/api/comfy/jobs/${created.json.id}`);

    check("状态", polled.json.state === "no_face", JSON.stringify(polled.json));
    check("进度", polled.json.progress === 100, String(polled.json.progress));

    mock.state.maskIsBlank = false;
    await request(baseUrl, `/api/comfy/jobs/${created.json.id}`, { method: "DELETE" });
  });

  /* ---------------------------- reveal ---------------------------- */

  await testAsync("reveal 只允许输出目录里的文件", async () => {
    const outside = await request(baseUrl, "/api/outputs/reveal", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ path: path.join(TEMP_BASE, "elsewhere.png") }),
    });

    check("状态码", outside.status === 500, String(outside.status));
    check(
      "错误文案",
      outside.json?.error === "The output path is outside the outputs directory.",
      outside.text,
    );

    const missing = await request(baseUrl, "/api/outputs/reveal", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ path: path.join(outputDir, "not-there.png") }),
    });

    check(
      "不存在的文件",
      missing.json?.error === "The output file no longer exists.",
      missing.text,
    );

    const empty = await request(baseUrl, "/api/outputs/reveal", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });

    check(
      "空路径",
      empty.json?.error === "The output path is empty.",
      empty.text,
    );
  });

  /* ---------------------------- 边界 ---------------------------- */

  await testAsync("API 路由允许多个请求并发（不会互相排队）", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(baseUrl, "/api/comfy/status")),
    );

    check(
      "全部成功",
      responses.every((item) => item.status === 200),
      responses.map((item) => item.status).join(","),
    );
  });

  test("safeOutputFileName 会清掉非法字符并强制 .png", () => {
    const service = createComfyService({
      webRoot: ROOT,
      outputDir: path.join(TEMP_BASE, "naming"),
      log: () => {},
    });

    const cases = [
      ["IMG_0001-AI.png", "IMG_0001-AI.png"],
      ["a/b\\c:d*e?f.png", "c_d_e_f.png"],
      ["", "ColorAdjustAI-job.png"],
      ["名字.png", "名字.png"],
      ["trailing...", "trailing.png"],
    ];

    for (const [input, expected] of cases) {
      const actual = service.safeOutputFileName(input, "job");

      check(
        `safeOutputFileName(${JSON.stringify(input)})`,
        actual === expected,
        `${actual} ≠ ${expected}`,
      );
    }

    service.dispose();
  });
  test("没配置时会自动探测常见安装位置", () => {
    // 先清掉前面写下的配置文件，走「自动探测」这条路
    fs.rmSync(
      path.join(process.env.LOCALAPPDATA, "ColorAdjustApp", "comfy.json"),
      { force: true },
    );

    const service = createComfyService({
      webRoot: ROOT,
      outputDir: path.join(TEMP_BASE, "autodetect"),
      log: () => {},
      defaultRoots: [install.root],
    });

    const status = service.getComfyConfig();

    check("自动探测到安装目录", status.root === install.root, status.root);
    check("默认端口是 8188", status.port === 8188, String(status.port));

    const info = service.resolveComfyInstall(status.root);

    check("安装目录有效", info.valid === true, info.error);
    check(
      "checkpoints 递归列出并按名字排序",
      JSON.stringify(service.getCheckpointFiles(info)) === JSON.stringify(install.models),
      JSON.stringify(service.getCheckpointFiles(info)),
    );
    check(
      "SAM 优先取 sam_vit_b_01ec64.pth",
      service.getFirstSamModel(info) === "sam_vit_b_01ec64.pth",
      service.getFirstSamModel(info),
    );

    service.dispose();
  });
}

main()
  .catch((error) => {
    failures.push({
      name: "测试脚本执行完成",
      message: error?.stack || String(error),
    });
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\n桌面桥接测试：${passed} 通过，${failures.length} 失败\n`);

      for (const failure of failures) {
        console.error(`  ✗ ${failure.name}\n    ${failure.message}`);
      }

      process.exitCode = 1;
    } else {
      console.log(`桌面桥接测试：${passed} 项全部通过`);
    }

    fs.rmSync(TEMP_BASE, { recursive: true, force: true });
  });
