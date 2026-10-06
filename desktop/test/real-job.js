/**
 * 真实 ComfyUI 的端到端联通测试（会按需启动 ComfyUI，结束后关掉自己启动的进程）。
 *
 * 它验证的是「上传 → 排队 → 执行 → 取回结果 / 判定人脸」这条链路在真实 ComfyUI 上
 * 能不能跑通。测试图没有人脸，因此正常结果多半是 no_face；no_face 与 succeeded
 * 都算通过，failed 才是失败。
 *
 * 运行：node desktop/test/real-job.js
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..", "..");
const { createBridgeServer } = require("../bridge");

const OUTPUT_DIR = path.join(
  process.env.USERPROFILE || os.homedir(),
  "Pictures",
  "ColorAdjustApp",
);

async function main() {
  const bridge = createBridgeServer({
    webRoot: ROOT,
    outputDir: OUTPUT_DIR,
    log: (message) => console.log("[bridge]", message),
  });
  const port = await bridge.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const imageBytes = fs.readFileSync(
    path.join(ROOT, "desktop", "build", "icon.png"),
  );

  try {
    const status = await fetchJson(`${baseUrl}/api/comfy/status`);

    console.log("安装目录：", status.root, "端口", status.port);
    console.log("依赖节点：", JSON.stringify(status.nodes));

    if (!status.valid || !status.models?.length) {
      throw new Error(`ComfyUI 未就绪：${status.error || "没有模型"}`);
    }

    const model = status.models[0];

    console.log("使用模型：", model);
    console.log("正在提交任务（首次会自动启动 ComfyUI，最多等 90 秒）...");

    const created = await fetchJson(`${baseUrl}/api/comfy/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-ColorAdjust-Model": encodeURIComponent(model),
        "X-ColorAdjust-Beautify": "0.5",
        "X-ColorAdjust-Detail": "0",
        "X-ColorAdjust-Output-Name": encodeURIComponent("desktop-selftest.png"),
      },
      body: imageBytes,
    });

    console.log("任务号：", created.id, "状态：", created.state);

    const deadline = Date.now() + 8 * 60 * 1000;
    let job = created;

    while (Date.now() < deadline) {
      job = await fetchJson(`${baseUrl}/api/comfy/jobs/${created.id}`);

      console.log(`  ${new Date().toLocaleTimeString()} state=${job.state} progress=${job.progress}`);

      if (["succeeded", "failed", "cancelled", "no_face"].includes(job.state)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    console.log("最终状态：", job.state, job.error || "");
    console.log("savedPath：", job.savedPath || "(无)");
    console.log("resultUrl：", job.resultUrl || "(无)");

    if (job.state === "failed") {
      throw new Error(`任务失败：${job.error}`);
    }

    if (job.state === "succeeded") {
      if (!fs.existsSync(job.savedPath)) {
        throw new Error("结果文件没有落盘");
      }

      const served = await fetch(`${baseUrl}${job.resultUrl}`);

      console.log(
        "结果可通过 /outputs 访问：",
        served.status,
        served.headers.get("content-type"),
      );

      fs.rmSync(job.savedPath, { force: true });
      console.log("已清理测试输出文件");
    }

    await fetch(`${baseUrl}/api/comfy/jobs/${created.id}`, { method: "DELETE" });
    console.log("\n真实 ComfyUI 联通测试：通过");
  } finally {
    await bridge.close();
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(`${url} → ${response.status} ${body?.error || text}`);
  }

  return body;
}

main().catch((error) => {
  console.error("\n真实 ComfyUI 联通测试：失败");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
