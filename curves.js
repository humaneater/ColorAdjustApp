/**
 * 曲线（Curves）模型。
 *
 * 与 Photoshop 的曲线一致：控制点是贝塞尔曲线的锚点，每个锚点带进/出两个控制柄，
 * 拖动控制柄即可改变该点的切线（斜率）。曲线整体必须保持「x 单调」，
 * 也就是一个输入值只对应一个输出值，因此控制柄的 x 分量会被限制在本段范围内。
 *
 * 数据表示（全部使用 0..1 归一化坐标，左下角为 (0,0)）：
 *   { x, y, in: { x, y }, out: { x, y } }
 *   in/out 是相对锚点的偏移量；in.x ≤ 0，out.x ≥ 0。
 *
 * 对外主要提供：
 *   sampleLut()   → 256 级查找表，直接上传给着色器
 *   flatten()     → 折线点列，用来画曲线
 *   buildHistogram() → R/G/B/亮度四条直方图
 *
 * 同时兼容浏览器（globalThis.ColorCurves）与 Node（module.exports），便于测试。
 */
(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ColorCurves = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 直方图与查找表的分级数。 */
  const LEVELS = 256;

  /** 每条曲线最多允许的锚点数，防止误操作产生海量点。 */
  const MAX_POINTS = 16;

  /** 通道定义：RGB 为复合曲线，其余为单通道曲线。 */
  const CHANNELS = Object.freeze([
    { id: "rgb", label: "RGB", color: "#e6ebf1" },
    { id: "r", label: "红", color: "#ff6b5e" },
    { id: "g", label: "绿", color: "#5ed17a" },
    { id: "b", label: "蓝", color: "#5f9bff" },
  ]);

  /** 每个通道在着色器查找表里的位置。 */
  const CHANNEL_KEYS = Object.freeze(["rgb", "r", "g", "b"]);

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function clonePoints(points) {
    return points.map((point) => ({
      x: point.x,
      y: point.y,
      in: { x: point.in.x, y: point.in.y },
      out: { x: point.out.x, y: point.out.y },
    }));
  }

  /** 对角直线：不改变画面，控制柄沿对角线摆放。 */
  function createIdentityPoints() {
    return [
      { x: 0, y: 0, in: { x: 0, y: 0 }, out: { x: 1 / 3, y: 1 / 3 } },
      { x: 1, y: 1, in: { x: -1 / 3, y: -1 / 3 }, out: { x: 0, y: 0 } },
    ];
  }

  function createCurveState() {
    const channels = {};

    for (const key of CHANNEL_KEYS) {
      channels[key] = createIdentityPoints();
    }

    return { channels, active: "rgb" };
  }

  /**
   * 约束控制柄：把 x 分量限制在允许范围内，同时**保持句柄方向（斜率）不变**，
   * 只缩短长度。如果直接把 x 夹紧而不管 y，句柄就会偏离原来的切线方向，
   * 一条本该笔直的曲线会莫名其妙地弯掉。
   */
  function constrainHandle(handle, minimumX, maximumX) {
    if (handle.x === 0 && handle.y === 0) {
      return;
    }

    const targetX = clamp(handle.x, minimumX, maximumX);
    const targetY = clamp(handle.y, -2, 2);
    let scale = 1;

    if (Math.abs(handle.x) > 1e-9) {
      scale = Math.min(scale, Math.abs(targetX / handle.x));
    }

    if (Math.abs(handle.y) > 1e-9) {
      scale = Math.min(scale, Math.abs(targetY / handle.y));
    }

    scale = clamp(scale, 0, 1);
    handle.x *= scale;
    handle.y *= scale;
  }

  /**
   * 规整一条曲线：端点固定在 x=0 / x=1，按 x 排序，
   * 并把控制柄限制在相邻区间内，保证曲线仍然是「一个 x 对一个 y」。
   */
  function sanitize(points) {
    const list = points
      .map((point) => ({
        x: clamp(point.x, 0, 1),
        y: clamp(point.y, 0, 1),
        in: { x: point.in.x, y: point.in.y },
        out: { x: point.out.x, y: point.out.y },
      }))
      .sort((left, right) => left.x - right.x)
      .slice(0, MAX_POINTS);

    if (list.length === 0) {
      return createIdentityPoints();
    }

    list[0].x = 0;
    list[list.length - 1].x = 1;

    for (let index = 0; index < list.length; index += 1) {
      const previous = list[index - 1];
      const next = list[index + 1];
      const leftSpan = previous ? list[index].x - previous.x : 0;
      const rightSpan = next ? next.x - list[index].x : 0;

      constrainHandle(list[index].in, -leftSpan / 2, 0);
      constrainHandle(list[index].out, 0, rightSpan / 2);
    }

    return list;
  }

  function cubicAt(p0, c0, c1, p1, t) {
    const inverse = 1 - t;
    const a = inverse * inverse * inverse;
    const b = 3 * inverse * inverse * t;
    const c = 3 * inverse * t * t;
    const d = t * t * t;

    return {
      x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
      y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
    };
  }

  /**
   * 把曲线展开成折线，用于绘制与重采样。
   *
   * @param {Array} points 锚点
   * @param {number} perSegment 每段的采样数
   */
  function flatten(points, perSegment = 48) {
    const list = sanitize(points);
    const path = [];
    const steps = Math.max(4, perSegment);

    for (let index = 0; index < list.length - 1; index += 1) {
      const start = list[index];
      const end = list[index + 1];
      const c0 = { x: start.x + start.out.x, y: start.y + start.out.y };
      const c1 = { x: end.x + end.in.x, y: end.y + end.in.y };

      for (let step = 0; step < steps; step += 1) {
        path.push(cubicAt(start, c0, c1, end, step / steps));
      }
    }

    const last = list[list.length - 1];

    path.push({ x: last.x, y: last.y });

    return path;
  }

  /**
   * 采样成 LEVELS 级查找表（0..255 整数）。
   * 曲线的 x 区间覆盖整条折线，这里按均匀 x 线性重采样。
   */
  function sampleLut(points, levels = LEVELS) {
    const path = flatten(points);
    const lut = new Uint8Array(levels);
    let cursor = 0;

    for (let index = 0; index < levels; index += 1) {
      const x = index / (levels - 1);

      while (cursor < path.length - 2 && path[cursor + 1].x < x) {
        cursor += 1;
      }

      const left = path[cursor];
      const right = path[Math.min(cursor + 1, path.length - 1)];
      const span = right.x - left.x;
      const ratio = span > 1e-9 ? (x - left.x) / span : 0;
      const y = clamp(left.y + (right.y - left.y) * ratio, 0, 1);

      lut[index] = Math.round(y * 255);
    }

    return lut;
  }

  function isIdentityLut(lut) {
    for (let index = 0; index < lut.length; index += 1) {
      const expected = Math.round((index / (lut.length - 1)) * 255);

      if (Math.abs(lut[index] - expected) > 1) {
        return false;
      }
    }

    return true;
  }

  function isIdentityPoints(points) {
    return isIdentityLut(sampleLut(points));
  }

  /** 在指定位置插入锚点，切线按相邻点自动计算，插入后曲线保持平滑。 */
  function insertPoint(points, x, y) {
    const list = sanitize(points);

    if (list.length >= MAX_POINTS) {
      return { points: list, index: -1 };
    }

    const position = clamp(x, 0, 1);
    const anchor = { x: position, y: clamp(y, 0, 1), in: { x: 0, y: 0 }, out: { x: 0, y: 0 } };
    let index = list.findIndex((point) => point.x > position);

    if (index <= 0) {
      index = list.length;
    }

    list.splice(index, 0, anchor);
    applyAutoHandles(list, index);

    return { points: sanitize(list), index };
  }

  /** 依据前后锚点给出平滑切线。 */
  function applyAutoHandles(list, index) {
    const previous = list[index - 1];
    const next = list[index + 1];
    const current = list[index];
    const leftSpan = previous ? current.x - previous.x : 0;
    const rightSpan = next ? next.x - current.x : 0;
    const denominator = (previous ? current.x - previous.x : 0) + (next ? next.x - current.x : 0);
    const slope =
      previous && next && denominator > 1e-6
        ? (next.y - previous.y) / (next.x - previous.x)
        : 0;

    current.in = { x: -leftSpan / 3, y: (-slope * leftSpan) / 3 };
    current.out = { x: rightSpan / 3, y: (slope * rightSpan) / 3 };
  }

  /** 删除锚点；两个端点不允许删除。 */
  function removePoint(points, index) {
    const list = sanitize(points);

    if (index <= 0 || index >= list.length - 1) {
      return { points: list, removed: false };
    }

    list.splice(index, 1);

    return { points: sanitize(list), removed: true };
  }

  /** 移动锚点：端点只能上下移动，中间点被夹在左右邻居之间。 */
  function movePoint(points, index, x, y) {
    const list = sanitize(points);
    const point = list[index];

    if (!point) {
      return list;
    }

    const isFirst = index === 0;
    const isLast = index === list.length - 1;
    const margin = 1 / LEVELS;
    let nextX = point.x;

    if (!isFirst && !isLast) {
      nextX = clamp(x, list[index - 1].x + margin, list[index + 1].x - margin);
    } else if (isFirst) {
      nextX = 0;
    } else {
      nextX = 1;
    }

    const deltaY = clamp(y, 0, 1) - point.y;

    point.x = nextX;
    point.y = point.y + deltaY;
    // 控制柄跟着锚点一起平移，形状保持不变
    point.in.x = clamp(point.in.x, -(nextX - (list[index - 1]?.x ?? nextX)), 0);
    point.out.x = clamp(point.out.x, 0, (list[index + 1]?.x ?? nextX) - nextX);

    return sanitize(list);
  }

  /**
   * 拖动控制柄，改变锚点处的斜率。
   *
   * @param {string} side "in" 或 "out"
   */
  function moveHandle(points, index, side, x, y) {
    const list = sanitize(points);
    const point = list[index];

    if (!point) {
      return list;
    }

    const isFirst = index === 0;
    const isLast = index === list.length - 1;

    if ((side === "in" && isFirst) || (side === "out" && isLast)) {
      return list;
    }

    if (side === "in") {
      const span = point.x - list[index - 1].x;

      point.in.x = clamp(x - point.x, -span / 2, 0);
      point.in.y = clamp(y - point.y, -2, 2);
    } else {
      const span = list[index + 1].x - point.x;

      point.out.x = clamp(x - point.x, 0, span / 2);
      point.out.y = clamp(y - point.y, -2, 2);
    }

    return sanitize(list);
  }

  /** 命中测试用的锚点/控制柄坐标。 */
  function handlePositions(points, index) {
    const list = sanitize(points);
    const point = list[index];

    if (!point) {
      return null;
    }

    return {
      anchor: { x: point.x, y: point.y },
      in: point.in.x === 0 && point.in.y === 0
        ? null
        : { x: point.x + point.in.x, y: point.y + point.in.y },
      out: point.out.x === 0 && point.out.y === 0
        ? null
        : { x: point.x + point.out.x, y: point.y + point.out.y },
    };
  }

  /**
   * 统计直方图。
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba 长度 = 像素数 * 4
   * @returns {{r: Uint32Array, g: Uint32Array, b: Uint32Array, luma: Uint32Array, count: number}}
   */
  function buildHistogram(rgba) {
    const r = new Uint32Array(LEVELS);
    const g = new Uint32Array(LEVELS);
    const b = new Uint32Array(LEVELS);
    const luma = new Uint32Array(LEVELS);
    const pixels = Math.floor(rgba.length / 4);
    let count = 0;

    for (let index = 0; index < pixels; index += 1) {
      const offset = index * 4;

      if (rgba[offset + 3] < 8) {
        continue;
      }

      const red = rgba[offset];
      const green = rgba[offset + 1];
      const blue = rgba[offset + 2];

      r[red] += 1;
      g[green] += 1;
      b[blue] += 1;
      luma[Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)] += 1;
      count += 1;
    }

    return { r, g, b, luma, count };
  }

  /** 按通道取出直方图数据。 */
  function histogramFor(histogram, channel) {
    if (!histogram) {
      return null;
    }

    return histogram[channel] || histogram.luma;
  }

  /**
   * 直方图显示用的归一化系数：忽略两端因削波产生的尖峰，
   * 否则一条极高的柱子会把其余部分压平。
   */
  function histogramScale(values) {
    if (!values) {
      return 1;
    }

    let reference = 0;

    for (let index = 1; index < values.length - 1; index += 1) {
      reference = Math.max(reference, values[index]);
    }

    if (reference === 0) {
      for (let index = 0; index < values.length; index += 1) {
        reference = Math.max(reference, values[index]);
      }
    }

    return reference > 0 ? reference : 1;
  }

  return {
    LEVELS,
    MAX_POINTS,
    CHANNELS,
    CHANNEL_KEYS,
    clamp,
    clonePoints,
    createIdentityPoints,
    createCurveState,
    sanitize,
    flatten,
    sampleLut,
    isIdentityLut,
    isIdentityPoints,
    insertPoint,
    removePoint,
    movePoint,
    moveHandle,
    handlePositions,
    applyAutoHandles,
    buildHistogram,
    histogramFor,
    histogramScale,
  };
});
