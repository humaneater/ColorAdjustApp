/**
 * curves.js 的回归测试（无第三方依赖）。
 *
 * 运行：node tools/curves.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const curves = require("../curves.js");

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

/** 曲线在 x 处的输出（0..1）。 */
function outputAt(points, x) {
  const lut = curves.sampleLut(points);

  return lut[Math.round(curves.clamp(x, 0, 1) * (lut.length - 1))] / 255;
}

/** 简易确定性随机数，保证测试可复现。 */
function makeRandom(seed) {
  let state = seed;

  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;

    return state / 2147483648;
  };
}

/* --------------------------- 基本形状 --------------------------- */

test("默认曲线是对角直线（不改变画面）", () => {
  const points = curves.createIdentityPoints();
  const lut = curves.sampleLut(points);

  assert.equal(lut.length, 256);

  for (let index = 0; index < lut.length; index += 1) {
    closeTo(lut[index], Math.round((index / 255) * 255), 1, `LUT[${index}]`);
  }

  assert.equal(curves.isIdentityPoints(points), true);
});

test("折线严格经过每个锚点", () => {
  const points = curves.sanitize([
    { x: 0, y: 0, in: { x: 0, y: 0 }, out: { x: 0.1, y: 0.3 } },
    { x: 0.4, y: 0.7, in: { x: -0.1, y: 0 }, out: { x: 0.1, y: 0 } },
    { x: 1, y: 1, in: { x: -0.2, y: -0.4 }, out: { x: 0, y: 0 } },
  ]);
  const path = curves.flatten(points, 64);

  for (const point of points) {
    const nearest = path.reduce((best, item) =>
      Math.hypot(item.x - point.x, item.y - point.y) <
      Math.hypot(best.x - point.x, best.y - point.y)
        ? item
        : best,
    );

    closeTo(nearest.x, point.x, 0.01, `锚点 ${point.x} 的 x`);
    closeTo(nearest.y, point.y, 0.01, `锚点 ${point.x} 的 y`);
  }
});

test("查表结果始终落在 0..255", () => {
  const random = makeRandom(7);
  const points = curves.sanitize([
    { x: 0, y: random(), in: { x: 0, y: 0 }, out: { x: 0.3, y: 1.5 } },
    { x: 0.5, y: random(), in: { x: -0.3, y: -1.5 }, out: { x: 0.3, y: 1.5 } },
    { x: 1, y: random(), in: { x: -0.3, y: -1.5 }, out: { x: 0, y: 0 } },
  ]);
  const lut = curves.sampleLut(points);

  for (const value of lut) {
    assert.ok(value >= 0 && value <= 255, `越界值 ${value}`);
    assert.ok(Number.isInteger(value), `非整数 ${value}`);
  }
});

test("曲线在 x 方向保持单调，不会一个输入对应多个输出", () => {
  const random = makeRandom(20250815);

  for (let round = 0; round < 200; round += 1) {
    const list = [
      {
        x: 0,
        y: random(),
        in: { x: 0, y: 0 },
        out: { x: random() * 2, y: random() * 4 - 2 },
      },
    ];
    const count = 1 + Math.floor(random() * 4);

    for (let index = 0; index < count; index += 1) {
      list.push({
        x: 0.15 + random() * 0.7,
        y: random(),
        in: { x: -random() * 2, y: random() * 4 - 2 },
        out: { x: random() * 2, y: random() * 4 - 2 },
      });
    }

    list.push({
      x: 1,
      y: random(),
      in: { x: -random() * 2, y: random() * 4 - 2 },
      out: { x: 0, y: 0 },
    });

    const path = curves.flatten(curves.sanitize(list), 32);

    for (let index = 1; index < path.length; index += 1) {
      assert.ok(
        path[index].x >= path[index - 1].x - 1e-9,
        `第 ${round} 轮第 ${index} 段 x 折返：${path[index - 1].x} → ${path[index].x}`,
      );
      assert.ok(Number.isFinite(path[index].y), `第 ${round} 轮出现非有限值`);
    }
  }
});

test("在恒等曲线上插入共线关键点，曲线仍然笔直", () => {
  const inserted = curves.insertPoint(curves.createIdentityPoints(), 0.5, 0.5);

  assert.equal(
    curves.isIdentityPoints(inserted.points),
    true,
    "插入 (0.5, 0.5) 后曲线仍是恒等曲线（端点句柄被夹紧时不能改变斜率）",
  );

  const removed = curves.removePoint(inserted.points, 1);

  assert.equal(curves.isIdentityPoints(removed.points), true, "删除后回到恒等曲线");

  const lut = curves.sampleLut(removed.points);

  for (let index = 0; index < lut.length; index += 1) {
    assert.equal(lut[index], index, `LUT[${index}] 应精确等于 ${index}`);
  }
});

test("夹紧控制柄只缩短长度，不改变方向", () => {
  const points = curves.sanitize([
    { x: 0, y: 0, in: { x: 0, y: 0 }, out: { x: 1, y: 1 } },
    { x: 0.2, y: 0.2, in: { x: -1, y: -1 }, out: { x: 1, y: 1 } },
    { x: 1, y: 1, in: { x: -1, y: -1 }, out: { x: 0, y: 0 } },
  ]);

  for (const point of points) {
    for (const side of ["in", "out"]) {
      const handle = point[side];

      if (Math.abs(handle.x) < 1e-9 && Math.abs(handle.y) < 1e-9) {
        continue;
      }

      if (Math.abs(handle.x) < 1e-9) {
        continue;
      }

      closeTo(
        handle.y / handle.x,
        1,
        1e-6,
        `${point.x} 处 ${side} 句柄斜率`,
      );
      assert.ok(Math.abs(handle.x) <= 0.5, `${side} 句柄应在区间内`);
    }
  }
});

/* --------------------------- 编辑操作 --------------------------- */

test("插入锚点后曲线经过该点，且仍保持排序", () => {
  const result = curves.insertPoint(curves.createIdentityPoints(), 0.5, 0.8);

  assert.ok(result.index > 0 && result.index < result.points.length - 1);
  closeTo(result.points[result.index].x, 0.5, 1e-6, "插入点 x");
  closeTo(outputAt(result.points, 0.5), 0.8, 0.01, "曲线经过插入点");

  const xs = result.points.map((point) => point.x);

  assert.deepEqual(xs, [...xs].sort((left, right) => left - right), "锚点应按 x 排序");
  assert.equal(xs[0], 0);
  assert.equal(xs[xs.length - 1], 1);
});

test("拖动锚点改变曲线，端点只能上下移动", () => {
  const base = curves.insertPoint(curves.createIdentityPoints(), 0.5, 0.5).points;
  const raised = curves.movePoint(base, 1, 0.5, 0.9);

  closeTo(outputAt(raised, 0.5), 0.9, 0.01, "中间点输出");

  const movedFirst = curves.movePoint(base, 0, 0.4, 0.3);

  closeTo(movedFirst[0].x, 0, 1e-9, "端点 x 固定");
  closeTo(movedFirst[0].y, 0.3, 1e-9, "端点 y 可调");

  const clamped = curves.movePoint(base, 1, 5, 5);

  assert.ok(clamped[1].x > clamped[0].x && clamped[1].x < clamped[2].x, "中点被夹在邻居之间");
  closeTo(clamped[1].y, 1, 1e-9, "y 被夹在 0..1");
});

test("拖动控制柄改变斜率，方向正确", () => {
  const base = curves.insertPoint(curves.createIdentityPoints(), 0.5, 0.5).points;
  const steeper = curves.moveHandle(base, 1, "out", 0.75, 0.95);
  const flatter = curves.moveHandle(base, 1, "out", 0.75, 0.05);

  const steepDelta = outputAt(steeper, 0.75) - outputAt(steeper, 0.5);
  const flatDelta = outputAt(flatter, 0.75) - outputAt(flatter, 0.5);
  const baseDelta = outputAt(base, 0.75) - outputAt(base, 0.5);

  assert.ok(steepDelta > baseDelta, `上挑控制柄应提高斜率：${steepDelta} vs ${baseDelta}`);
  assert.ok(flatDelta < baseDelta, `下压控制柄应降低斜率：${flatDelta} vs ${baseDelta}`);
});

test("端点外侧不存在控制柄", () => {
  const points = curves.createIdentityPoints();
  const unchanged = curves.moveHandle(points, 0, "in", -0.5, 0.5);

  assert.deepEqual(unchanged, curves.sanitize(points));

  const positions = curves.handlePositions(points, 0);

  assert.equal(positions.in, null, "首点没有进控制柄");
  assert.ok(positions.out, "首点应有出控制柄");
  assert.equal(curves.handlePositions(points, 1).out, null, "末点没有出控制柄");
});

test("删除锚点：中间点可删，端点不可删", () => {
  const base = curves.insertPoint(curves.createIdentityPoints(), 0.3, 0.6).points;
  const withTwo = curves.insertPoint(base, 0.7, 0.2).points;

  assert.equal(withTwo.length, 4);

  const removed = curves.removePoint(withTwo, 1);

  assert.equal(removed.removed, true);
  assert.equal(removed.points.length, 3);

  assert.equal(curves.removePoint(removed.points, 0).removed, false);
  assert.equal(
    curves.removePoint(removed.points, removed.points.length - 1).removed,
    false,
  );
});

test("锚点数量有上限", () => {
  let points = curves.createIdentityPoints();

  for (let index = 1; index < 40; index += 1) {
    points = curves.insertPoint(points, index / 40, 0.5).points;
  }

  assert.ok(points.length <= curves.MAX_POINTS, `锚点过多：${points.length}`);
});

/* --------------------------- 效果 --------------------------- */

test("S 形曲线提高中间调对比，并保持两端", () => {
  let points = curves.createIdentityPoints();

  points = curves.insertPoint(points, 0.25, 0.15).points;
  points = curves.insertPoint(points, 0.75, 0.85).points;

  closeTo(outputAt(points, 0), 0, 0.01, "黑场");
  closeTo(outputAt(points, 1), 1, 0.01, "白场");
  assert.ok(outputAt(points, 0.25) < 0.25, "暗调被压低");
  assert.ok(outputAt(points, 0.75) > 0.75, "亮调被抬高");
  assert.equal(curves.isIdentityPoints(points), false);
});

test("反相曲线把黑白对调", () => {
  const points = curves.sanitize([
    { x: 0, y: 1, in: { x: 0, y: 0 }, out: { x: 1 / 3, y: -1 / 3 } },
    { x: 1, y: 0, in: { x: -1 / 3, y: 1 / 3 }, out: { x: 0, y: 0 } },
  ]);

  closeTo(outputAt(points, 0), 1, 0.01, "黑→白");
  closeTo(outputAt(points, 1), 0, 0.01, "白→黑");
  closeTo(outputAt(points, 0.5), 0.5, 0.01, "中间灰不变");
});

test("重复 x 的退化输入不会产生 NaN", () => {
  const points = curves.sanitize([
    { x: 0.5, y: 0.2, in: { x: -0.9, y: 0 }, out: { x: 0.9, y: 0 } },
    { x: 0.5, y: 0.8, in: { x: -0.9, y: 0 }, out: { x: 0.9, y: 0 } },
    { x: 0.5, y: 0.5, in: { x: -0.9, y: 0 }, out: { x: 0.9, y: 0 } },
  ]);

  assert.ok(points.length >= 2);

  for (const value of curves.sampleLut(points)) {
    assert.ok(Number.isFinite(value), "查找表出现非有限值");
  }
});

/* --------------------------- 直方图 --------------------------- */

test("直方图统计正确的分级", () => {
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
    128, 64, 200, 255,
    10, 10, 10, 0,
  ]);
  const histogram = curves.buildHistogram(rgba);

  assert.equal(histogram.count, 3, "全透明像素应被跳过");
  assert.equal(histogram.r[0], 1);
  assert.equal(histogram.r[255], 1);
  assert.equal(histogram.r[128], 1);
  assert.equal(histogram.g[64], 1);
  assert.equal(histogram.b[200], 1);
  assert.equal(histogram.luma[255], 1, "白色计入最高亮度级");
  assert.equal(histogram.luma[0], 1, "黑色计入最低亮度级");
});

test("直方图归一化忽略两端的削波尖峰", () => {
  const values = new Uint32Array(256);

  values[0] = 100000;
  values[255] = 50000;

  for (let index = 1; index < 255; index += 1) {
    values[index] = 100;
  }

  assert.equal(curves.histogramScale(values), 100);

  const flat = new Uint32Array(256);

  flat[0] = 7;
  assert.equal(curves.histogramScale(flat), 7, "全是尖峰时退回整体最大值");
  assert.equal(curves.histogramScale(null), 1);
});

test("通道直方图接口对未知通道回退到亮度", () => {
  const histogram = curves.buildHistogram(new Uint8ClampedArray([10, 20, 30, 255]));

  assert.equal(curves.histogramFor(histogram, "rgb"), histogram.luma);
  assert.equal(curves.histogramFor(histogram, "r"), histogram.r);
  assert.equal(curves.histogramFor(null, "r"), null);
});

/* --------------------------- 状态 --------------------------- */

test("初始曲线状态包含全部四个通道且都是恒等曲线", () => {
  const state = curves.createCurveState();

  assert.deepEqual(Object.keys(state.channels).sort(), ["b", "g", "r", "rgb"]);
  assert.equal(state.active, "rgb");

  for (const key of curves.CHANNEL_KEYS) {
    assert.equal(curves.isIdentityPoints(state.channels[key]), true, `${key} 应为恒等`);
  }
});

test("四通道定义与着色器查找表位置一致", () => {
  assert.deepEqual(
    curves.CHANNELS.map((channel) => channel.id),
    curves.CHANNEL_KEYS,
  );
});

/* ------------------------------ 结果汇总 ------------------------------ */

if (failures.length > 0) {
  console.error(`\n曲线数学测试：${passed} 通过，${failures.length} 失败\n`);

  for (const failure of failures) {
    console.error(`  ✗ ${failure.name}\n    ${failure.message}`);
  }

  process.exitCode = 1;
} else {
  console.log(`曲线数学测试：${passed} 项全部通过`);
}
