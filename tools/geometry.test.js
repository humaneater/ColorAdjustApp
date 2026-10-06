/**
 * geometry.js 的回归测试（无第三方依赖）。
 *
 * 重点验证两件事：
 *   1. viewMatrix 把输出画布映射回源图的方向、角度、裁切是否正确
 *      （90° 旋转后角点应该搬到对应位置、裁切后只显示框内内容）；
 *   2. 自动裁掉空白算出来的框，四个角确实都落在原图内。
 *
 * 运行：node tools/geometry.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const geo = require("../geometry.js");

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

function stateWith(overrides) {
  return { ...geo.createState(), ...overrides };
}

/** 输出画布上的像素中心 → 源图像素坐标（左上角为原点）。 */
function sourcePixel(texture, state, output, x, y) {
  return geo.outputToSource(
    texture.width,
    texture.height,
    state,
    output.width,
    output.height,
    x + 0.5,
    y + 0.5,
  );
}

function makeTexture(width, height) {
  return { width, height };
}

function makeOutput(texture, state) {
  return geo.viewSize(texture.width, texture.height, state);
}

/* ---------------------------- 默认状态 ---------------------------- */

test("默认状态是恒等映射", () => {
  const state = geo.createState();
  const texture = makeTexture(400, 300);

  assert.equal(geo.isIdentity(state), true);
  assert.equal(geo.totalAngle(state), 0);

  const size = geo.viewSize(texture.width, texture.height, state);

  assert.deepEqual(size, { width: 400, height: 300 });

  const matrix = geo.viewMatrix(texture.width, texture.height, state);

  closeTo(matrix[0], 400, 1e-6, "m00");
  closeTo(matrix[4], 300, 1e-6, "m11");
  closeTo(matrix[6], 0, 1e-6, "平移 x");
  closeTo(matrix[7], 0, 1e-6, "平移 y");
  closeTo(matrix[1], 0, 1e-6, "m10");
  closeTo(matrix[3], 0, 1e-6, "m01");
});

test("恒等状态下每个像素都原样对应", () => {
  const texture = makeTexture(64, 48);
  const state = geo.createState();
  const output = makeOutput(texture, state);

  for (const [x, y] of [
    [0, 0],
    [10, 20],
    [63, 47],
  ]) {
    const point = sourcePixel(texture, state, output, x, y);

    closeTo(point.x, x + 0.5, 1e-4, `x=${x}`);
    closeTo(point.y, y + 0.5, 1e-4, `y=${y}`);
  }
});

/* ---------------------------- 90° 步进 ---------------------------- */

test("右转 90°：原图左下角转到画面左上角", () => {
  const texture = makeTexture(4, 2);
  const state = geo.rotateQuarter(geo.createState(), 1);
  const output = makeOutput(texture, state);

  assert.deepEqual(output, { width: 2, height: 4 });

  const corner = sourcePixel(texture, state, output, 0, 0);

  closeTo(corner.x, 0.5, 1e-4, "左上角映射到的源 x");
  closeTo(corner.y, 1.5, 1e-4, "左上角映射到的源 y");
});

test("左转 90°：原图右上角转到画面左上角", () => {
  const texture = makeTexture(4, 2);
  const state = geo.rotateQuarter(geo.createState(), -1);
  const output = makeOutput(texture, state);

  assert.deepEqual(output, { width: 2, height: 4 });

  const corner = sourcePixel(texture, state, output, 0, 0);

  closeTo(corner.x, 3.5, 1e-4, "左上角映射到的源 x");
  closeTo(corner.y, 0.5, 1e-4, "左上角映射到的源 y");
});

test("转两次 90° 等于 180°", () => {
  const texture = makeTexture(6, 4);
  let state = geo.createState();

  state = geo.rotateQuarter(state, 1);
  state = geo.rotateQuarter(state, 1);

  assert.equal(geo.totalAngle(state), 180);

  const output = makeOutput(texture, state);

  assert.deepEqual(output, { width: 6, height: 4 });

  const corner = sourcePixel(texture, state, output, 0, 0);

  closeTo(corner.x, 5.5, 1e-4, "左上角映射到的源 x");
  closeTo(corner.y, 3.5, 1e-4, "左上角映射到的源 y");
});

test("四个 90° 回到初始状态", () => {
  let state = geo.createState();

  for (let index = 0; index < 4; index += 1) {
    state = geo.rotateQuarter(state, 1);
  }

  assert.equal(state.quarter, 0);
  assert.equal(geo.isIdentity(state), true);
});

test("90° 旋转时裁切框跟着画面一起转", () => {
  const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const once = geo.rotateCrop90(crop, 1);

  closeTo(once.x, 1 - 0.2 - 0.4, 1e-9, "顺时针后的 x");
  closeTo(once.y, 0.1, 1e-9, "顺时针后的 y");
  closeTo(once.width, 0.4, 1e-9, "顺时针后的宽");
  closeTo(once.height, 0.3, 1e-9, "顺时针后的高");

  const back = geo.rotateCrop90(once, -1);

  closeTo(back.x, crop.x, 1e-9, "转回来的 x");
  closeTo(back.y, crop.y, 1e-9, "转回来的 y");
  closeTo(back.width, crop.width, 1e-9, "转回来的宽");
  closeTo(back.height, crop.height, 1e-9, "转回来的高");
});

test("旋转 90° 时画面里的内容跟着一起搬", () => {
  const texture = makeTexture(8, 4);
  const crop = { x: 0.25, y: 0, width: 0.5, height: 0.5 };
  const before = stateWith({ crop });
  const after = geo.rotateQuarter(before, 1);
  const beforeOutput = makeOutput(texture, before);
  const afterOutput = makeOutput(texture, after);
  // 取旋转前画面中心对应的原图像素，旋转后它应该出现在新画面的中心
  const center = sourcePixel(
    texture,
    before,
    beforeOutput,
    (beforeOutput.width - 1) / 2,
    (beforeOutput.height - 1) / 2,
  );
  const moved = geo.sourceToOutput(
    texture.width,
    texture.height,
    after,
    afterOutput.width,
    afterOutput.height,
    center.x,
    center.y,
  );

  closeTo(moved.x, (afterOutput.width - 1) / 2 + 0.5, 0.6, "旋转后落在画面中心的 x");
  closeTo(moved.y, (afterOutput.height - 1) / 2 + 0.5, 0.6, "旋转后落在画面中心的 y");
});

/* ---------------------------- 裁切 ---------------------------- */

test("裁切框决定输出尺寸", () => {
  const texture = makeTexture(1000, 500);
  const state = stateWith({ crop: { x: 0.25, y: 0.2, width: 0.5, height: 0.4 } });
  const output = geo.viewSize(texture.width, texture.height, state);

  assert.deepEqual(output, { width: 500, height: 200 });
  assert.equal(geo.isIdentity(state), false);
});

test("裁切后输出只覆盖裁切框内的内容", () => {
  const texture = makeTexture(1000, 500);
  const crop = { x: 0.25, y: 0.2, width: 0.5, height: 0.4 };
  const state = stateWith({ crop });
  const output = makeOutput(texture, state);
  const input = geo.cropRect(
    { width: texture.width, height: texture.height },
    crop,
  );
  const topLeft = sourcePixel(texture, state, output, 0, 0);
  const bottomRight = sourcePixel(
    texture,
    state,
    output,
    output.width - 1,
    output.height - 1,
  );

  closeTo(topLeft.x, input.x + 0.5, 1e-3, "左上角源 x");
  closeTo(topLeft.y, input.y + 0.5, 1e-3, "左上角源 y");
  closeTo(bottomRight.x, input.x + input.width - 0.5, 1e-3, "右下角源 x");
  closeTo(bottomRight.y, input.y + input.height - 0.5, 1e-3, "右下角源 y");
});

test("裁切 + 旋转后输出仍然是裁切框大小", () => {
  const texture = makeTexture(600, 400);
  const state = stateWith({
    angle: 7.5,
    crop: { x: 0.2, y: 0.1, width: 0.6, height: 0.5 },
  });
  const bounds = geo.rotatedBounds(texture.width, texture.height, 7.5);
  const output = geo.viewSize(texture.width, texture.height, state);

  closeTo(output.width, bounds.width * 0.6, 1, "输出宽");
  closeTo(output.height, bounds.height * 0.5, 1, "输出高");
});

test("裁切框换算可以来回转换", () => {
  const bounds = { width: 800, height: 600 };
  const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
  const rect = geo.cropRect(bounds, crop);
  const back = geo.cropFromRect(bounds, rect);

  closeTo(back.x, crop.x, 1e-9, "x");
  closeTo(back.y, crop.y, 1e-9, "y");
  closeTo(back.width, crop.width, 1e-9, "宽");
  closeTo(back.height, crop.height, 1e-9, "高");
});

test("越界的裁切框会被收回画面内", () => {
  const crop = geo.normalizeCrop({ x: 0.9, y: -0.4, width: 0.8, height: 2 });

  assert.ok(crop.x >= 0 && crop.x + crop.width <= 1 + 1e-9, `x=${crop.x}`);
  assert.ok(crop.y >= 0 && crop.y + crop.height <= 1 + 1e-9, `y=${crop.y}`);
  assert.ok(crop.width >= geo.MIN_CROP_RATIO - 1e-9);
  assert.ok(crop.height <= 1 + 1e-9);
});

/* ---------------------------- 翻转 ---------------------------- */

test("翻转不改变输出尺寸，只镜像画面", () => {
  const texture = makeTexture(64, 32);
  const base = stateWith({ crop: { x: 0, y: 0, width: 1, height: 1 } });
  const flipped = geo.toggleFlip(base, "h");
  const output = makeOutput(texture, base);
  const flippedOutput = makeOutput(texture, flipped);

  assert.deepEqual(flippedOutput, output);

  const left = sourcePixel(texture, base, output, 0, 10);
  const right = sourcePixel(texture, flipped, flippedOutput, 0, 10);

  closeTo(right.x, texture.width - left.x, 1e-4, "水平翻转后的源 x");

  const vertical = geo.toggleFlip(base, "v");
  const top = sourcePixel(texture, base, output, 10, 0);
  const bottom = sourcePixel(
    texture,
    vertical,
    makeOutput(texture, vertical),
    10,
    0,
  );

  closeTo(bottom.y, texture.height - top.y, 1e-4, "垂直翻转后的源 y");
});

test("翻转与旋转可以叠加", () => {
  const texture = makeTexture(64, 32);
  let state = geo.rotateQuarter(geo.createState(), 1);

  state = geo.toggleFlip(state, "v");

  const output = makeOutput(texture, state);

  assert.deepEqual(output, { width: 32, height: 64 });
  assert.equal(geo.isIdentity(state), false);
});

/* ---------------------------- 微调角度 ---------------------------- */

test("旋转后外接矩形按标准公式放大", () => {
  const bounds = geo.rotatedBounds(1000, 500, 10);
  const radians = (10 * Math.PI) / 180;

  closeTo(
    bounds.width,
    1000 * Math.cos(radians) + 500 * Math.sin(radians),
    1e-9,
    "外接宽",
  );
  closeTo(
    bounds.height,
    1000 * Math.sin(radians) + 500 * Math.cos(radians),
    1e-9,
    "外接高",
  );
});

test("角度会归一化到 (-180, 180]", () => {
  closeTo(geo.normalizeAngle(370), 10, 1e-9, "370°");
  closeTo(geo.normalizeAngle(-370), -10, 1e-9, "-370°");
  closeTo(geo.normalizeAngle(180), 180, 1e-9, "180°");
  closeTo(geo.normalizeAngle(-540), 180, 1e-9, "-540°");
  closeTo(geo.totalAngle(stateWith({ quarter: 1, angle: 15 })), 105, 1e-9);
  closeTo(geo.totalAngle(stateWith({ quarter: 3, angle: -20 })), -110, 1e-9);
});

/* ---------------------------- 自动裁掉空白 ---------------------------- */

test("自动裁掉空白：每个角度下四角都在原图内", () => {
  const texture = makeTexture(1200, 800);

  for (const angle of [1, 3, 5, 10, 17.5, 30, 45, 62, 90, 110, 135, 179]) {
    const crop = geo.inscribedCrop(
      texture.width,
      texture.height,
      stateWith({ angle }),
    );
    const state = stateWith({ angle, crop });
    const bounds = geo.rotatedBounds(texture.width, texture.height, angle);
    const rect = geo.cropRect(bounds, crop);
    const output = geo.viewSize(texture.width, texture.height, state);
    const samples = [];

    for (const u of [0, 0.5, 1]) {
      for (const v of [0, 0.5, 1]) {
        samples.push([u * output.width, v * output.height]);
      }
    }

    for (const [x, y] of samples) {
      const point = geo.outputToSource(
        texture.width,
        texture.height,
        state,
        output.width,
        output.height,
        x,
        y,
      );

      assert.ok(
        point.x >= -0.5 &&
          point.x <= texture.width + 0.5 &&
          point.y >= -0.5 &&
          point.y <= texture.height + 0.5,
        `${angle}° 时 (${x.toFixed(0)}, ${y.toFixed(0)}) 落到了画面外：` +
          `源 (${point.x.toFixed(1)}, ${point.y.toFixed(1)})，裁切框 ` +
          `${rect.width.toFixed(0)}×${rect.height.toFixed(0)}`,
      );
    }
  }
});

test("自动裁掉空白：0° 与 90° 都不裁", () => {
  const texture = makeTexture(1200, 800);
  const zero = geo.inscribedCrop(texture.width, texture.height, geo.createState());

  closeTo(zero.x, 0, 1e-6, "0° 的 x");
  closeTo(zero.y, 0, 1e-6, "0° 的 y");
  closeTo(zero.width, 1, 1e-6, "0° 的宽");
  closeTo(zero.height, 1, 1e-6, "0° 的高");

  const quarter = geo.inscribedCrop(
    texture.width,
    texture.height,
    geo.rotateQuarter(geo.createState(), 1),
  );

  closeTo(quarter.x, 0, 1e-6, "90° 的 x");
  closeTo(quarter.y, 0, 1e-6, "90° 的 y");
  closeTo(quarter.width, 1, 1e-5, "90° 的宽");
  closeTo(quarter.height, 1, 1e-5, "90° 的高");
});

test("自动裁掉空白会随着角度变大而裁得更多", () => {
  const texture = makeTexture(1200, 800);
  const areas = [0, 5, 15, 30].map((angle) => {
    const crop = geo.inscribedCrop(
      texture.width,
      texture.height,
      stateWith({ angle }),
    );

    return crop.width * crop.height;
  });

  for (let index = 1; index < areas.length; index += 1) {
    assert.ok(
      areas[index] < areas[index - 1],
      `角度变大后保留面积应当变小：${areas.join(" → ")}`,
    );
  }
});

test("正方形旋转 45° 后自动裁切保留一半面积", () => {
  const rect = geo.inscribedRect(1000, 1000, 45, 1);

  closeTo(rect.width, 1000 / Math.SQRT2, 1e-6, "内接正方形边长");
});

/* ---------------------------- 比例预设 ---------------------------- */

test("比例预设会得到准确的像素宽高比", () => {
  const bounds = geo.rotatedBounds(1000, 600, 12);
  const crop = { x: 0.1, y: 0.1, width: 0.6, height: 0.6 };

  for (const id of ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"]) {
    const ratio = geo.aspectRatio(id, 1000 / 600);
    const next = geo.applyAspect(crop, ratio, bounds);
    const actual =
      (next.width * bounds.width) / (next.height * bounds.height);

    closeTo(actual, ratio, 1e-6, `${id} 的实际比例`);
    assert.ok(
      next.x >= -1e-9 && next.x + next.width <= 1 + 1e-9,
      `${id} 超出画面：x=${next.x}`,
    );
    assert.ok(
      next.y >= -1e-9 && next.y + next.height <= 1 + 1e-9,
      `${id} 超出画面：y=${next.y}`,
    );
  }
});

test("原始比例预设跟随画面比例", () => {
  const bounds = geo.rotatedBounds(1200, 800, 0);
  const next = geo.applyAspect(
    { x: 0, y: 0, width: 1, height: 1 },
    geo.aspectRatio("original", 1200 / 800),
    bounds,
  );

  closeTo(next.width, 1, 1e-9, "宽");
  closeTo(next.height, 1, 1e-9, "高");
});

test("自由比例不做任何限制", () => {
  assert.equal(geo.aspectRatio("free", 1.5), null);
});

/* ---------------------------- 拖动裁切框 ---------------------------- */

test("拖动裁切框内部只平移不改大小", () => {
  const crop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  const moved = geo.dragCrop(crop, "move", 0.1, 0.05, null);

  closeTo(moved.x, 0.3, 1e-9, "x");
  closeTo(moved.y, 0.25, 1e-9, "y");
  closeTo(moved.width, 0.4, 1e-9, "宽");
  closeTo(moved.height, 0.4, 1e-9, "高");
});

test("拖动裁切框不会跑出画面", () => {
  const crop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  const moved = geo.dragCrop(crop, "move", 5, -5, null);

  closeTo(moved.x + moved.width, 1, 1e-9, "右边界");
  closeTo(moved.y, 0, 1e-9, "上边界");
});

test("拖动左上角手柄同时改两条边", () => {
  const crop = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
  const next = geo.dragCrop(crop, "nw", 0.1, 0.2, null);

  closeTo(next.x, 0.3, 1e-9, "x");
  closeTo(next.y, 0.4, 1e-9, "y");
  closeTo(next.x + next.width, 0.8, 1e-9, "右边界不动");
  closeTo(next.y + next.height, 0.8, 1e-9, "下边界不动");
});

test("锁比例拖动时保持比例", () => {
  const crop = { x: 0.1, y: 0.1, width: 0.4, height: 0.3 };
  const ratio = 2;
  const next = geo.dragCrop(crop, "se", 0.2, 0.2, ratio);

  closeTo(next.width / next.height, ratio, 1e-6, "拖动后的比例");
  assert.ok(next.x + next.width <= 1 + 1e-9, "没有超出画面");
  assert.ok(next.y + next.height <= 1 + 1e-9, "没有超出画面");
});

test("裁切框最小边长会被守住", () => {
  const crop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  const next = geo.dragCrop(crop, "e", -5, 0, null);

  assert.ok(
    next.width >= geo.MIN_CROP_RATIO - 1e-9,
    `宽度变成了 ${next.width}`,
  );
});

/* ---------------------------- 坐标来回换算 ---------------------------- */

test("outputToSource 与 sourceToOutput 互为逆运算", () => {
  const texture = makeTexture(640, 480);
  const states = [
    geo.createState(),
    stateWith({ angle: 12.5 }),
    stateWith({ quarter: 1, crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.6 } }),
    stateWith({ flipH: true, flipV: true, angle: -8, quarter: 3 }),
  ];

  for (const state of states) {
    const output = makeOutput(texture, state);

    for (const [x, y] of [
      [0, 0],
      [output.width / 3, output.height / 4],
      [output.width - 1, output.height - 1],
    ]) {
      const source = geo.outputToSource(
        texture.width,
        texture.height,
        state,
        output.width,
        output.height,
        x,
        y,
      );
      const back = geo.sourceToOutput(
        texture.width,
        texture.height,
        state,
        output.width,
        output.height,
        source.x,
        source.y,
      );

      closeTo(back.x, x, 1e-3, "回来的 x");
      closeTo(back.y, y, 1e-3, "回来的 y");
    }
  }
});

test("viewTransform 与 sourceToOutput 描述同一组映射", () => {
  const texture = makeTexture(640, 480);
  const states = [
    geo.createState(),
    stateWith({ angle: 9.5 }),
    stateWith({ quarter: 1, crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.6 } }),
    stateWith({ flipH: true, angle: -12, quarter: 3, crop: { x: 0.3, y: 0.05, width: 0.4, height: 0.7 } }),
  ];

  for (const state of states) {
    const output = makeOutput(texture, state);
    const transform = geo.viewTransform(
      texture.width,
      texture.height,
      state,
      output.width,
      output.height,
    );

    for (const [x, y] of [
      [0, 0],
      [texture.width / 2, texture.height / 3],
      [texture.width - 1, texture.height - 1],
    ]) {
      // Canvas 的 setTransform(a, b, c, d, e, f)：x' = ax + cy + e
      const outX = transform.a * x + transform.c * y + transform.e;
      const outY = transform.b * x + transform.d * y + transform.f;
      const expected = geo.sourceToOutput(
        texture.width,
        texture.height,
        state,
        output.width,
        output.height,
        x,
        y,
      );

      closeTo(outX, expected.x, 1e-6, "输出的 x");
      closeTo(outY, expected.y, 1e-6, "输出的 y");
    }
  }
});

test("画面外的源点会被判定为不可见", () => {
  const texture = makeTexture(400, 400);
  const state = stateWith({ angle: 20 });

  assert.equal(
    geo.isSourcePointVisible(texture.width, texture.height, state, 400, 400, 200, 200),
    true,
  );
  assert.equal(
    geo.isSourcePointVisible(
      texture.width,
      texture.height,
      stateWith({ crop: { x: 0, y: 0, width: 0.2, height: 0.2 } }),
      400,
      400,
      380,
      380,
    ),
    false,
  );
});

/* ---------------------------- 文案 ---------------------------- */

test("摘要文案能反映当前几何", () => {
  assert.equal(geo.describe(geo.createState(), 100, 100), "未调整");
  assert.equal(geo.describe(stateWith({ angle: 5.5 }), 100, 100), "旋转 5.5°");
  assert.equal(
    geo.describe(stateWith({ quarter: 1 }), 100, 50),
    "旋转 90°",
  );
  assert.equal(
    geo.describe(stateWith({ flipH: true, flipV: true }), 100, 100),
    "水平翻转 · 垂直翻转",
  );
  assert.equal(
    geo.describe(
      stateWith({ crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }),
      400,
      200,
    ),
    "裁切 200 × 100",
  );
});

/* ------------------------------ 结果汇总 ------------------------------ */

if (failures.length > 0) {
  console.error(`\n旋转裁切几何测试：${passed} 通过，${failures.length} 失败\n`);

  for (const failure of failures) {
    console.error(`  ✗ ${failure.name}\n    ${failure.message}`);
  }

  process.exitCode = 1;
} else {
  console.log(`旋转裁切几何测试：${passed} 项全部通过`);
}
