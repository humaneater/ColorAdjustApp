/**
 * 用真实的 ComfyUI 安装目录检查桥接层的探测结果（不会启动 ComfyUI，也不改配置）。
 *
 * 运行：node desktop/test/real-status.js
 */
"use strict";

const path = require("node:path");
const { createComfyService } = require("../comfy");

const service = createComfyService({
  webRoot: path.resolve(__dirname, "..", ".."),
  outputDir: path.join(__dirname, "..", "dist", "status-probe"),
  log: () => {},
});

const config = service.getComfyConfig();
const info = service.resolveComfyInstall(config.root);

console.log("配置里的安装目录：", config.root || "(空)");
console.log("监听端口：", config.port);
console.log("目录有效：", info.valid, info.error || "");
console.log("main.py：", info.mainPath);
console.log("python：", info.pythonPath);
console.log("依赖节点：", JSON.stringify(service.getNodeState(info)));
console.log("SAM 首选：", service.getFirstSamModel(info) || "(无)");

const models = service.getCheckpointFiles(info);

console.log(`checkpoints（${models.length}）：`);
for (const model of models.slice(0, 10)) {
  console.log("  -", model);
}

service.dispose();
