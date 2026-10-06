/**
 * posterize.js 的回归测试（无第三方依赖）。
 *
 * 运行：node tools/posterize.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const posterize = require("../posterize.js");

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

/** 一段 0..1 的值经过量化后剩下多少种取值。 */
function distinctCount(values, levels) {
  return new Set(values.map((value) => posterize.quantize(value, levels).toFixed(6)))
    .size;
}

/* ---------------------------- 分级公式 ---------------------------- */

test("黑白场永远映射到自身", () => {
  for (const levels of [2, 3, 5, 8, 32]) {
    closeTo(posterize.quantize(0, levels), 0, 1e-9, `${levels} 级黑场`);
    closeTo(posterize.quantize(1, levels), 1, 1e-9, `${levels} 级白场`);
  }
});

test("N 级量化后最多只有 N 种取值", () => {
  const ramp = Array.from({ length: 1000 }, (_, index) => index / 999);

  for (const levels of [2, 3, 4, 8, 16, 32]) {
    const count = distinctCount(ramp, levels);

    assert.ok(count <= levels, `${levels} 级出现了 ${count} 种取值`);
    assert.ok(count >= levels - 1, `${levels} 级只出现了 ${count} 种取值`);
  }
});

test("量化结果均匀分布，且单调不减", () => {
  const output = Array.from({ length: 100 }, (_, index) =>
    posterize.quantize(index / 99, 5),
  );

  for (let index = 1; index < output.length; index += 1) {
    assert.ok(output[index] >= output[index - 1], `第 ${index} 项出现回退`);
  }

  const unique = Array.from(new Set(output));

  assert.deepEqual(unique, [0, 0.25, 0.5, 0.75, 1]);
});

test("超出范围或非法级数会被夹紧", () => {
  closeTo(posterize.quantize(-3, 8), 0, 1e-9, "负值");
  closeTo(posterize.quantize(9, 8), 1, 1e-9, "超界值");
  closeTo(posterize.quantize(0.5, 1), 1, 1e-9, "级数下限夹到 2");
  closeTo(posterize.quantize(0.5, 999), 0.5, 1e-3, "级数上限夹到 32");
  closeTo(posterize.quantize(0.5, Number.NaN), 0.5, 0.1, "非法级数回退到默认");
});

/* ---------------------------- 状态解析 ---------------------------- */

test("默认状态：关闭、8 级、强度 0", () => {
  const state = posterize.createState();
  const resolved = posterize.resolve(state);

  assert.equal(state.enabled, false);
  assert.equal(state.levels, 8);
  assert.equal(state.amount, 0);
  assert.equal(state.mode, "luma");
  assert.equal(resolved.enabled, false, "默认不应改变画面");
  assert.equal(posterize.describe(state), "已关闭");
});

test("启用状态：8 级、100%、按亮度、三通道全开", () => {
  const resolved = posterize.resolve(posterize.createActiveState());

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.levels, 8);
  assert.equal(resolved.amount, 1);
  assert.equal(resolved.mode, 0);
  assert.deepEqual(resolved.channels, [1, 1, 1]);
});

test("关闭勾选框时参数全部保留，只是不作用到画面", () => {
  const active = {
    enabled: true,
    levels: 6,
    amount: 80,
    mode: "channels",
    channels: { r: true, g: false, b: true },
  };
  const off = { ...active, enabled: false };
  const resolvedOn = posterize.resolve(active);
  const resolvedOff = posterize.resolve(off);

  assert.equal(resolvedOn.enabled, true);
  assert.equal(resolvedOff.enabled, false, "取消勾选后不应生效");
  assert.equal(resolvedOff.levels, resolvedOn.levels, "级数应保留");
  assert.equal(resolvedOff.amount, resolvedOn.amount, "强度应保留");
  assert.equal(resolvedOff.mode, resolvedOn.mode, "模式应保留");
  assert.deepEqual(resolvedOff.channels, resolvedOn.channels, "通道应保留");
  assert.equal(posterize.describe(off), "已关闭");
  assert.match(posterize.describe(active), /6 级 · 80%/);
});

test("强度 0 时不生效", () => {
  const resolved = posterize.resolve({ enabled: true, amount: 0 });

  assert.equal(resolved.enabled, false);
  assert.match(posterize.describe({ enabled: true, amount: 0 }), /强度 0/);
});

test("按通道模式下可以只分离部分通道", () => {
  const state = {
    enabled: true,
    amount: 100,
    mode: "channels",
    channels: { r: true, g: false, b: false },
  };
  const resolved = posterize.resolve(state);

  assert.equal(resolved.mode, 1);
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.channels, [1, 0, 0]);
  assert.match(posterize.describe(state), /R/);
});

test("通道全部关闭时按通道模式不生效", () => {
  const state = {
    enabled: true,
    amount: 100,
    mode: "channels",
    channels: { r: false, g: false, b: false },
  };
  const resolved = posterize.resolve(state);

  assert.equal(resolved.enabled, false);
  assert.match(posterize.describe(state), /未选择任何通道/);
});

test("按亮度模式下通道开关不影响是否生效", () => {
  const resolved = posterize.resolve({
    enabled: true,
    amount: 100,
    mode: "luma",
    channels: { r: false, g: false, b: false },
  });

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.mode, 0);
});

test("级数被夹在 2..32，未知模式回退到按亮度", () => {
  assert.equal(posterize.resolve({ levels: 1 }).levels, 2);
  assert.equal(posterize.resolve({ levels: 400 }).levels, 32);
  assert.equal(posterize.resolve({ levels: 12.6 }).levels, 13);
  assert.equal(posterize.resolve({ mode: "无此模式" }).modeId, "luma");
});

test("级数非法时回退到默认值", () => {
  assert.equal(posterize.resolve({ levels: Number.NaN }).levels, 8);
  assert.equal(posterize.resolve({ levels: undefined }).levels, 8);
});

/* ---------------------------- 摘要与预览 ---------------------------- */

test("摘要文本包含级数、强度与模式信息", () => {
  assert.match(posterize.describe({ enabled: true, levels: 6, amount: 80 }), /6 级 · 80%/);
  assert.match(posterize.describe({ enabled: true, levels: 6, amount: 80 }), /按亮度/);
  assert.match(
    posterize.describe({
      enabled: true,
      amount: 100,
      mode: "channels",
      channels: { r: true, g: true, b: false },
    }),
    /R\+G/,
  );
});

test("预览条颜色：关闭的通道保持连续，开启的通道呈色块", () => {
  const smooth = Array.from({ length: 32 }, (_, index) =>
    posterize.previewColor(index / 31, "r", false, 4),
  );
  const banded = Array.from({ length: 32 }, (_, index) =>
    posterize.previewColor(index / 31, "r", true, 4),
  );

  assert.equal(new Set(smooth).size > new Set(banded).size, true, "未开启时取值应更多");
  assert.ok(smooth.every((color) => /^rgb\(\d+,\d+,\d+\)$/.test(color)), "颜色格式");
  assert.ok(banded.every((color) => /^rgb\(\d+,\d+,\d+\)$/.test(color)), "颜色格式");
});

test("预览条的亮度模式是灰阶", () => {
  const color = posterize.previewColor(0.5, "luma", true, 8);
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);

  assert.ok(match, `颜色格式：${color}`);
  assert.equal(match[1], match[2]);
  assert.equal(match[2], match[3]);
});

/* ---------------------------- 元数据 ---------------------------- */

test("模式与通道定义完整且顺序稳定", () => {
  assert.deepEqual(
    posterize.MODES.map((mode) => mode.id),
    ["luma", "channels"],
  );
  assert.deepEqual(
    posterize.CHANNELS.map((channel) => channel.id),
    ["r", "g", "b"],
  );
  assert.equal(posterize.MIN_LEVELS, 2);
  assert.equal(posterize.MAX_LEVELS, 32);
});

/* ------------------------------ 结果汇总 ------------------------------ */

if (failures.length > 0) {
  console.error(`\n色调分离数学测试：${passed} 通过，${failures.length} 失败\n`);

  for (const failure of failures) {
    console.error(`  ✗ ${failure.name}\n    ${failure.message}`);
  }

  process.exitCode = 1;
} else {
  console.log(`色调分离数学测试：${passed} 项全部通过`);
}
