/**
 * white-balance.js 的回归测试（无第三方依赖）。
 *
 * 运行：node tools/white-balance.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const wb = require("../white-balance.js");

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

function closeTo(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label || "数值"} 期望 ${expected}，实际 ${actual}（容差 ${tolerance}）`,
  );
}

function closeVector(actual, expected, tolerance, label) {
  for (let index = 0; index < expected.length; index += 1) {
    closeTo(actual[index], expected[index], tolerance, `${label || "向量"}[${index}]`);
  }
}

/** 断言一个颜色是中性灰（三个通道相等），白平衡不应改变亮度，只改变色偏。 */
function assertNeutral(rgb, tolerance, label) {
  closeTo(rgb[0], rgb[1], tolerance, `${label} R/G`);
  closeTo(rgb[2], rgb[1], tolerance, `${label} B/G`);
}

/** 合成一张「中性表面在给定光源下」的线性光分析缓冲。 */
function neutralSceneUnder(illuminant, options = {}) {
  const reflectances = options.reflectances || [0.06, 0.18, 0.35, 0.55, 0.9];
  const width = reflectances.length * 2;
  const height = 2;
  const data = new Float32Array(width * height * 3);
  let index = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const reflectance = reflectances[(x + y) % reflectances.length];

      data[index] = illuminant[0] * reflectance;
      data[index + 1] = illuminant[1] * reflectance;
      data[index + 2] = illuminant[2] * reflectance;
      index += 3;
    }
  }

  return { data, width, height, count: width * height };
}

/** 合成一张「大部分是单色物体，但存在白色参考物」的场景。 */
function mostlyBlueSceneWithWhitePatch(illuminant) {
  const white = 0.9;
  const blue = [0.05, 0.1, 0.85];
  const width = 10;
  const height = 10;
  const data = new Float32Array(width * height * 3);

  for (let index = 0; index < width * height; index += 1) {
    const reflectance = index < 20 ? [white, white, white] : blue;

    data[index * 3] = illuminant[0] * reflectance[0];
    data[index * 3 + 1] = illuminant[1] * reflectance[1];
    data[index * 3 + 2] = illuminant[2] * reflectance[2];
  }

  return { data, width, height, count: width * height };
}

/** 构造一个物理上合理的光源颜色（位于色温轨迹附近，而不是随便挑的 RGB）。 */
function realisticIlluminant(kelvin) {
  const xy = wb.cctToXy(kelvin, 0);

  return wb.xyToLinearRgb(xy[0], xy[1]);
}

/* ------------------------------ 线性代数 ------------------------------ */

test("invert3(A) * A = I", () => {
  const matrix = [1.2, 0.3, -0.1, 0.05, 0.9, 0.2, -0.02, 0.11, 1.4];
  const product = wb.multiply3(wb.invert3(matrix), matrix);

  closeVector(product, wb.identity3(), 1e-9, "逆矩阵乘积");
});

test("toColumnMajor 与 apply3 的顺序一致", () => {
  const matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const columnMajor = wb.toColumnMajor(matrix);

  assert.deepEqual(Array.from(columnMajor), [1, 4, 7, 2, 5, 8, 3, 6, 9]);
  closeVector(wb.apply3(matrix, [1, 0, 0]), [1, 4, 7], 1e-12, "第一列");
});

test("blendWithIdentity 在两端取到单位矩阵与目标矩阵", () => {
  const matrix = [2, 0, 0, 0, 3, 0, 0, 0, 4];

  closeVector(wb.blendWithIdentity(matrix, 0), wb.identity3(), 1e-12, "strength=0");
  closeVector(wb.blendWithIdentity(matrix, 1), matrix, 1e-12, "strength=1");
  closeVector(
    wb.blendWithIdentity(matrix, 0.5),
    [1.5, 0, 0, 0, 2, 0, 0, 0, 2.5],
    1e-12,
    "strength=0.5",
  );
});

/* --------------------------- 色温与轨迹 --------------------------- */

test("日光轨迹在 6504K 处等于 D65", () => {
  const xy = wb.daylightXy(6504);

  closeTo(xy[0], wb.D65_XY[0], 5e-4, "x");
  closeTo(xy[1], wb.D65_XY[1], 5e-4, "y");
});

test("黑体轨迹是 CCT/Duv 的标准参考轨迹，D65 在它上方（偏绿）", () => {
  const xy = wb.planckianXy(6500);
  const estimate = wb.xyToCct(xy[0], xy[1], "planck");

  closeTo(estimate.kelvin, 6500, 60, "普朗克轨迹 6500K 反算");
  closeTo(estimate.duv, 0, 2e-3, "标准轨迹上 Duv 应为 0");

  const d65 = wb.xyToCct(wb.D65_XY[0], wb.D65_XY[1], "planck");

  closeTo(d65.kelvin, 6504, 60, "D65 色温");
  assert.ok(d65.duv > 0.002, `D65 相对黑体轨迹应偏绿，实际 Duv=${d65.duv}`);
});

test("色温滑条使用的轨迹在 2000K-12000K 连续，没有拼接跳变", () => {
  let previous = wb.cctToXy(2000, 0);

  for (let kelvin = 2001; kelvin <= 12000; kelvin += 1) {
    const current = wb.cctToXy(kelvin, 0);
    const step = Math.hypot(current[0] - previous[0], current[1] - previous[1]);

    assert.ok(step < 3e-4, `${kelvin}K 处轨迹出现跳变，Δxy=${step}`);
    previous = current;
  }
});

test("xyToCct 与 cctToXy 在 2000K-12000K 往返一致", () => {
  for (const kelvin of [2000, 2856, 4000, 5000, 5500, 6500, 8000, 12000]) {
    const xy = wb.cctToXy(kelvin, 0);
    const estimate = wb.xyToCct(xy[0], xy[1]);

    assert.ok(estimate.valid, `${kelvin}K 应判定为有效`);
    closeTo(estimate.kelvin, kelvin, Math.max(2, kelvin * 0.005), `${kelvin}K 往返`);
    closeTo(estimate.duv, 0, 5e-4, `${kelvin}K Duv 往返`);
  }
});

test("Duv 正负号：正值偏绿，负值偏品红，且与色调滑条方向相反", () => {
  const neutral = wb.cctToXy(6500, 0, "planck");
  const green = wb.cctToXy(6500, 0.02, "planck");
  const magenta = wb.cctToXy(6500, -0.02, "planck");
  const greenRgb = wb.xyToLinearRgb(green[0], green[1]);
  const magentaRgb = wb.xyToLinearRgb(magenta[0], magenta[1]);
  const neutralRgb = wb.xyToLinearRgb(neutral[0], neutral[1]);

  assert.ok(greenRgb[1] > neutralRgb[1], "偏绿方向绿色分量应更大");
  assert.ok(magentaRgb[1] < neutralRgb[1], "偏品红方向绿色分量应更小");
  assert.ok(
    magentaRgb[0] / magentaRgb[1] > neutralRgb[0] / neutralRgb[1],
    "偏品红方向 R/G 应更大",
  );

  for (const duv of [-0.015, -0.005, 0.005, 0.015]) {
    const xy = wb.cctToXy(5500, duv);
    const estimate = wb.xyToCct(xy[0], xy[1]);

    closeTo(estimate.duv, duv, 1e-5, `Duv=${duv} 往返`);
    assert.ok(
      Math.sign(estimate.tint) === Math.sign(duv) || duv === 0,
      `Duv=${duv} 的色调符号应与 Duv 相同（滑条正值 = 画面偏品红 = 光源偏绿）`,
    );
  }
});

/* --------------------------- 色适应变换 --------------------------- */

test("所有 CAT 空间都能把源白点精确映射到目标白点", () => {
  for (const kelvin of [2856, 4200, 6500, 9000]) {
    const source = wb.cctToXy(kelvin, 0.01);

    for (const id of Object.keys(wb.CAT_SPACES)) {
      const matrix = wb.matrixFromIlluminantXy(source, { catSpace: id });
      const white = wb.apply3(matrix, wb.xyToLinearRgb(source[0], source[1]));

      closeVector(white, [1, 1, 1], 2e-3, `CAT=${id} ${kelvin}K 白光`);
    }
  }
});

test("D65 → D65 的色适应是单位矩阵", () => {
  for (const id of Object.keys(wb.CAT_SPACES)) {
    const matrix = wb.matrixFromIlluminantXy(wb.D65_XY, { catSpace: id });

    closeVector(matrix, wb.identity3(), 1e-6, `CAT=${id}`);
  }
});

test("色温越高画面越暖，单调且可逆", () => {
  const warmth = (kelvin) => {
    const response = wb.apply3(wb.matrixFromKelvin(kelvin, 0), [1, 1, 1]);

    return response[0] / response[2];
  };

  closeTo(warmth(6500), 1, 0.01, "6500K 应基本中性");
  assert.ok(warmth(9000) > 1.4, `9000K 应明显偏暖，实际 R/B=${warmth(9000)}`);
  assert.ok(warmth(3000) < 0.2, `3000K 应明显偏冷，实际 R/B=${warmth(3000)}`);
  assert.ok(warmth(12000) > warmth(9000), "12000K 应比 9000K 更暖");
  assert.ok(warmth(8000) > warmth(6500), "8000K 应比 6500K 更暖");
  assert.ok(warmth(5000) < warmth(6500), "5000K 应比 6500K 更冷");
});

test("色温矩阵对「假定光源」严格中性，且不产生非有限值", () => {
  for (const kelvin of [2000, 2500, 2856, 4000, 5200, 6500, 8000, 12000]) {
    const illuminant = wb.cctToXy(kelvin, 0);
    const matrix = wb.matrixFromIlluminantXy(illuminant);
    const corrected = wb.apply3(matrix, wb.xyToLinearRgb(illuminant[0], illuminant[1]));

    // 假定光源被校正为参考白，这正是白平衡的定义
    closeVector(corrected, [1, 1, 1], 3e-3, `${kelvin}K 光源中性`);

    // 灰阶只会被推向暖/冷（这正是白平衡的可见效果），但不允许出现非有限值
    const gray = wb.apply3(matrix, [0.18, 0.18, 0.18]);

    assert.ok(gray.every((value) => Number.isFinite(value)), `${kelvin}K 灰阶非有限`);
    assert.ok(gray[1] > 0 && gray[1] < 2, `${kelvin}K 灰阶亮度异常：${gray[1]}`);
  }
});

test("极端色温的矩阵仍然有限且幅度受控", () => {
  for (const kelvin of [2000, 12000]) {
    const matrix = wb.matrixFromKelvin(kelvin, 0);

    assert.ok(matrix.every((value) => Number.isFinite(value)), `${kelvin}K 应全为有限值`);
    assert.ok(
      matrix.every((value) => Math.abs(value) < 12),
      `${kelvin}K 矩阵元素过大：${matrix.map((value) => value.toFixed(2)).join(", ")}`,
    );
  }
});

/* --------------------------- 光源估计 --------------------------- */

test("灰度世界能还原中性场景的光源", () => {
  const illuminant = [0.42, 1, 0.27];
  const buffer = neutralSceneUnder(illuminant);
  const estimate = wb.estimateIlluminant(buffer, "grayWorld");

  closeVector([estimate.r, estimate.g, estimate.b], [0.42, 1, 0.27], 1e-4, "灰度世界");
});

test("Shades of Gray 与白点算法在纯中性场景下与灰度世界一致", () => {
  const buffer = neutralSceneUnder([0.62, 1, 0.45]);

  for (const algorithm of ["shadesOfGray", "whitePatch", "percentileWhite", "grayEdge"]) {
    const estimate = wb.estimateIlluminant(buffer, algorithm);

    closeVector(
      [estimate.r, estimate.g, estimate.b],
      [0.62, 1, 0.45],
      5e-3,
      algorithm,
    );
  }
});

test("大面积单色场景下白点算法比灰度世界更稳健", () => {
  const buffer = mostlyBlueSceneWithWhitePatch([0.5, 1, 0.5]);
  const grayWorld = wb.estimateIlluminant(buffer, "grayWorld");
  const whitePatch = wb.estimateIlluminant(buffer, "whitePatch");

  assert.ok(grayWorld.b / grayWorld.r > 3, "灰度世界应被蓝色大面积带偏");
  closeVector([whitePatch.r, whitePatch.g, whitePatch.b], [0.5, 1, 0.5], 1e-3, "白点");
});

test("估计出的光源经矩阵校正后变中性", () => {
  const buffer = neutralSceneUnder([0.55, 1, 0.31]);
  const estimate = wb.estimateIlluminant(buffer, "grayWorld");
  const matrix = wb.matrixFromLinearRgb([estimate.r, estimate.g, estimate.b]);
  const result = wb.apply3(matrix, [estimate.r, estimate.g, estimate.b]);

  assertNeutral(result, 2e-3, "光源校正");
});

/* --------------------------- 界面状态解析 --------------------------- */

test("关闭与手动模式不产生矩阵", () => {
  for (const mode of ["off", "manual"]) {
    const resolved = wb.resolve({ mode }, null);

    assert.equal(resolved.enabled, false, `${mode} 应停用矩阵`);
    closeVector(resolved.matrix, wb.identity3(), 1e-12, `${mode} 矩阵`);
  }
});

test("开尔文模式在 6500K 时接近单位矩阵，在 9000K 时变暖", () => {
  const neutral = wb.resolve({ mode: "kelvin", kelvin: 6500, tint: 0 }, null);
  const warm = wb.resolve({ mode: "kelvin", kelvin: 9000, tint: 0 }, null);
  const response = wb.apply3(warm.matrix, [1, 1, 1]);

  assert.ok(
    wb.maxAbsDifference(neutral.matrix, wb.identity3()) < 5e-3,
    "6500K 应基本等于不调整",
  );
  assert.ok(warm.enabled, "9000K 应启用矩阵");
  assert.equal(warm.effectiveKelvin, 9000);
  assert.ok(response[0] > response[2] * 1.4, "9000K 应暖色");
});

test("色调滑条：正值让画面偏品红，负值让画面偏绿", () => {
  const magenta = wb.resolve({ mode: "kelvin", kelvin: 6500, tint: 60 }, null);
  const green = wb.resolve({ mode: "kelvin", kelvin: 6500, tint: -60 }, null);
  const magentaResponse = wb.apply3(magenta.matrix, [1, 1, 1]);
  const greenResponse = wb.apply3(green.matrix, [1, 1, 1]);

  // 偏品红 = 绿色分量被压低、红蓝相对抬高
  assert.ok(
    magentaResponse[1] < magentaResponse[0] && magentaResponse[1] < magentaResponse[2],
    `正色调应让中性色偏品红，实际 ${magentaResponse.map((v) => v.toFixed(3)).join(", ")}`,
  );
  assert.ok(
    greenResponse[1] > greenResponse[0] && greenResponse[1] > greenResponse[2],
    `负色调应让中性色偏绿，实际 ${greenResponse.map((v) => v.toFixed(3)).join(", ")}`,
  );
});

test("灰点模式在未拾取时停用，拾取后把该点校正为中性", () => {
  const idle = wb.resolve({ mode: "grayPoint" }, null);

  assert.equal(idle.enabled, false);
  assert.match(idle.detail, /尚未拾取/);

  const sample = { r: 0.42, g: 0.61, b: 0.35 };
  const picked = wb.resolve({ mode: "grayPoint", sample }, null);

  assert.ok(picked.enabled);
  assertNeutral(wb.apply3(picked.matrix, [sample.r, sample.g, sample.b]), 2e-3, "灰点校正");
});

test("自动模式缺少分析数据时停用，有数据时启用并给出等效色温", () => {
  const buffer = neutralSceneUnder(realisticIlluminant(4500));
  const idle = wb.resolve({ mode: "auto", algorithm: "grayWorld" }, null);
  const active = wb.resolve({ mode: "auto", algorithm: "grayWorld" }, buffer);

  assert.equal(idle.enabled, false);
  assert.equal(idle.detail, "等待画面分析");
  assert.ok(active.enabled);
  closeTo(active.effectiveKelvin, 4500, 60, "自动分析的光源色温");
  assert.ok(Math.abs(active.equivalentTint) <= 100, "等效色调应在滑条范围内");
});

test("自动分析的结果可以用色温 + 色调复现", () => {
  const buffer = neutralSceneUnder(realisticIlluminant(4200));
  const automatic = wb.resolve({ mode: "auto", algorithm: "grayWorld" }, buffer);
  const manual = wb.resolve(
    {
      mode: "kelvin",
      kelvin: automatic.effectiveKelvin,
      tint: automatic.equivalentTint,
    },
    null,
  );

  closeVector(manual.matrix, automatic.matrix, 0.05, "自动 ↔ 手动");
});

test("强度 0 会退化为不调整", () => {
  const resolved = wb.resolve(
    { mode: "auto", algorithm: "grayWorld", strength: 0 },
    neutralSceneUnder(realisticIlluminant(4500)),
  );

  assert.equal(resolved.enabled, false);
  closeVector(resolved.matrix, wb.identity3(), 1e-12, "strength=0");
});

test("强度 50 的偏移量约为全量的一半", () => {
  const buffer = neutralSceneUnder(realisticIlluminant(4500));
  const full = wb.resolve({ mode: "auto", strength: 100 }, buffer);
  const half = wb.resolve({ mode: "auto", strength: 50 }, buffer);

  assert.ok(half.enabled);
  closeTo(half.matrix[2], full.matrix[2] / 2, 1e-6, "矩阵偏移减半");
});

test("RGB 增益模式：默认 0 不改变画面，+50 让红通道变成 2 倍", () => {
  const neutral = wb.resolve({ mode: "gains", gains: { r: 0, g: 0, b: 0 } }, null);
  const warmer = wb.resolve({ mode: "gains", gains: { r: 50, g: 0, b: 0 } }, null);

  assert.equal(neutral.enabled, false, "默认增益应视为无变化");
  assert.ok(warmer.enabled);
  closeTo(warmer.matrix[0], 2, 1e-9, "红增益 +50 滑条 = 2 倍");
  closeTo(warmer.matrix[4], 1, 1e-9, "绿通道保持 1");
  closeTo(wb.gainSliderToFactor(-100), 0.25, 1e-9, "-100 滑条 = 0.25 倍");
  closeTo(wb.gainSliderToFactor(100), 4, 1e-9, "+100 滑条 = 4 倍");
});

test("预设表包含所有常见的场景白平衡", () => {
  const ids = wb.WB_PRESETS.map((preset) => preset.id);
  const required = [
    "daylight",
    "cloudy",
    "shade",
    "incandescent",
    "fluorescentWarm",
    "fluorescentCool",
    "flash",
  ];

  for (const id of required) {
    assert.ok(ids.includes(id), `缺少预设 ${id}`);
  }

  for (const preset of wb.WB_PRESETS) {
    if (preset.id === "custom") {
      continue;
    }

    assert.ok(preset.kelvin >= 1500 && preset.kelvin <= 12000, `${preset.id} 色温越界`);
    assert.ok(Math.abs(preset.tint) <= 100, `${preset.id} 色调越界`);
  }
});

test("所有下拉菜单中的白平衡方式都有实现分支", () => {
  const modes = wb.WB_MODES.map((mode) => mode.id);

  assert.deepEqual(modes, [
    "manual",
    "kelvin",
    "preset",
    "auto",
    "grayPoint",
    "gains",
    "off",
  ]);

  for (const mode of wb.WB_MODES) {
    const resolved = wb.resolve(
      { ...wb.defaultWhiteBalanceState(), mode: mode.id, sample: { r: 0.5, g: 0.6, b: 0.4 } },
      neutralSceneUnder([0.5, 1, 0.4]),
    );

    assert.equal(resolved.mode, mode.id);
    assert.equal(resolved.columnMajor.length, 9, `${mode.id} 矩阵长度`);
    assert.ok(
      Array.from(resolved.columnMajor).every((value) => Number.isFinite(value)),
      `${mode.id} 矩阵出现非有限值`,
    );
  }
});

test("病态灰点样本不会产生 NaN 或无穷大", () => {
  for (const sample of [
    { r: 0, g: 0, b: 0 },
    { r: 0.9, g: 0.4, b: 0 },
    { r: Number.NaN, g: 0.5, b: 0.5 },
  ]) {
    const resolved = wb.resolve({ mode: "grayPoint", sample }, null);

    assert.ok(
      Array.from(resolved.columnMajor).every((value) => Number.isFinite(value)),
      `样本 ${JSON.stringify(sample)} 产生了非有限矩阵`,
    );
  }
});

test("createAnalysisBuffer 跳过全透明像素并线性化 sRGB", () => {
  const rgba = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 0,
    255, 0, 0, 255,
  ]);
  const buffer = wb.createAnalysisBuffer(rgba, 3, 1);

  assert.equal(buffer.count, 2);
  closeTo(buffer.data[0], 1, 1e-6, "白色线性值");
  closeTo(buffer.data[3], 1, 1e-6, "红色 R");
  closeTo(buffer.data[5], 0, 1e-6, "红色 B");
});

/* ------------------------------ 结果汇总 ------------------------------ */

if (failures.length > 0) {
  console.error(`\n白平衡数学测试：${passed} 通过，${failures.length} 失败\n`);

  for (const failure of failures) {
    console.error(`  ✗ ${failure.name}\n    ${failure.message}`);
  }

  process.exitCode = 1;
} else {
  console.log(`白平衡数学测试：${passed} 项全部通过`);
}
