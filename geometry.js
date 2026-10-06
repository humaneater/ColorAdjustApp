/**
 * 旋转与裁切几何模型（geometry.js）。
 *
 * 把「画面几何」统一成四个纯数据参数：
 *   quarter  90° 步进（0-3，顺时针为正，对应四个按钮档位）
 *   angle    微调角度（-45°～45°，用来拉直地平线）
 *   flipH/flipV  水平 / 垂直镜像（作用在最终画面上）
 *   crop     裁切框，用「旋转后画面外接矩形」的归一化坐标表示（0-1）
 *
 * 模块对外只提供两样东西，预览与导出共用同一套数学：
 *   1. viewSize()   输出画布尺寸（裁切框在旋转后画面里占的像素数）；
 *   2. viewMatrix() 3x3 仿射矩阵，把输出画布的归一化坐标（原点左下、y 向上，
 *      与 gl_FragCoord / uv 一致）映射到源图纹理坐标（x 向右，
 *      y 从图像底部向上，单位是纹素）。
 *
 * 注意 y 的朝向：矩阵输出的是 GL 风格的纹理坐标，因此源图自上而下的
 * 像素坐标 ySource = textureHeight - yMatrix。outputToSource / sourceToOutput
 * 已经把这一步换算好，界面只和自上而下的像素坐标打交道。
 *
 * 兼容浏览器（globalThis.ColorGeometry）与 Node（module.exports），便于测试。
 */
(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ColorGeometry = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 微调角度范围：更大的角度用 90° 步进按钮，滑条只负责拉直。 */
  const MAX_FINE_ANGLE = 45;
  /** 裁切框最小边长（占画面比例），避免被拖成一条线。 */
  const MIN_CROP_RATIO = 0.04;
  /** 裁切比例预设；ratio 为 null 表示不锁定比例。 */
  const ASPECTS = Object.freeze([
    { id: "free", label: "自由", ratio: null },
    { id: "original", label: "原始比例", ratio: null },
    { id: "1:1", label: "1:1", ratio: 1 },
    { id: "4:3", label: "4:3", ratio: 4 / 3 },
    { id: "3:2", label: "3:2", ratio: 3 / 2 },
    { id: "16:9", label: "16:9", ratio: 16 / 9 },
    { id: "3:4", label: "3:4", ratio: 3 / 4 },
    { id: "2:3", label: "2:3", ratio: 2 / 3 },
    { id: "9:16", label: "9:16", ratio: 9 / 16 },
  ]);
  /** 未裁切时的默认框。 */
  const FULL_CROP = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  /** 角度归一化到 (-180, 180]，方便显示与比较。 */
  function normalizeAngle(degrees) {
    const value = Number(degrees) || 0;

    if (!Number.isFinite(value)) {
      return 0;
    }

    const wrapped = (((value + 180) % 360) + 360) % 360 - 180;

    return wrapped === -180 ? 180 : wrapped;
  }

  function createState() {
    return {
      quarter: 0,
      angle: 0,
      flipH: false,
      flipV: false,
      crop: { ...FULL_CROP },
    };
  }

  /** 90° 步进与微调角度合成的实际旋转角（顺时针为正）。 */
  function totalAngle(state) {
    if (!state) {
      return 0;
    }

    return normalizeAngle((Number(state.quarter) || 0) * 90 + (Number(state.angle) || 0));
  }

  /** 归一化坐标 → 实际像素坐标（外接矩形的长宽由 rotatedBounds 给出）。 */
  function normalizeCrop(crop) {
    const source = crop || {};
    const rawWidth = Number(source.width);
    const rawHeight = Number(source.height);
    const width = clamp(
      isFiniteNumber(rawWidth) ? rawWidth : 1,
      MIN_CROP_RATIO,
      1,
    );
    const height = clamp(
      isFiniteNumber(rawHeight) ? rawHeight : 1,
      MIN_CROP_RATIO,
      1,
    );

    return {
      x: clamp(Number(source.x) || 0, 0, 1 - width),
      y: clamp(Number(source.y) || 0, 0, 1 - height),
      width,
      height,
    };
  }

  /** 旋转后整幅画面的外接矩形（像素）。 */
  function rotatedBounds(width, height, angleDegrees) {
    const radians = (normalizeAngle(angleDegrees) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));

    return {
      width: Math.max(0, width) * cos + Math.max(0, height) * sin,
      height: Math.max(0, width) * sin + Math.max(0, height) * cos,
    };
  }

  /** 归一化裁切框 → 外接矩形内的像素裁切框。 */
  function cropRect(bounds, crop) {
    const safe = normalizeCrop(crop);

    return {
      x: safe.x * bounds.width,
      y: safe.y * bounds.height,
      width: safe.width * bounds.width,
      height: safe.height * bounds.height,
    };
  }

  /** 像素裁切框 → 归一化裁切框。 */
  function cropFromRect(bounds, rect) {
    const width = Math.max(1e-6, Number(bounds?.width) || 0);
    const height = Math.max(1e-6, Number(bounds?.height) || 0);

    return normalizeCrop({
      x: (Number(rect?.x) || 0) / width,
      y: (Number(rect?.y) || 0) / height,
      width: (Number(rect?.width) || 0) / width,
      height: (Number(rect?.height) || 0) / height,
    });
  }

  /** 输出画布尺寸（像素）。 */
  function viewSize(textureWidth, textureHeight, state) {
    const bounds = rotatedBounds(
      textureWidth,
      textureHeight,
      totalAngle(state),
    );
    const rect = cropRect(bounds, state?.crop);

    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  /**
   * 输出画布坐标 → 源图纹理坐标的仿射矩阵（列主序，直接喂给 GLSL mat3）。
   *
   * 推导（s、t 为裁切框内 0-1 的坐标，t 自上而下）：
   *   s' = fx0 + fx1 * s        （水平翻转）
   *   t' = fy0 + fy1 * t        （垂直翻转）
   *   外接矩形坐标 xr = x + s' * w，yr = y + t' * h
   *   相对画面中心 (xr - W'/2, yr - H'/2) 逆时针转回 -θ 即得源图偏移
   *   u = W/2 + cosθ * dx + sinθ * dy      （dx、dy 为外接矩形内的偏移）
   *   v = H/2 + sinθ * dx - cosθ * dy      （v 自图像底部向上）
   * 注意 t = 1 - outUv.y，所以 outUv.y 的系数与 t 的系数反号。
   */
  function viewMatrix(textureWidth, textureHeight, state) {
    const degrees = totalAngle(state);
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const bounds = rotatedBounds(textureWidth, textureHeight, degrees);
    const rect = cropRect(bounds, state?.crop);
    const flipH = Boolean(state?.flipH);
    const flipV = Boolean(state?.flipV);
    // s' = fx0 + fx1 * s
    const fx0 = flipH ? 1 : 0;
    const fx1 = flipH ? -1 : 1;
    const fy0 = flipV ? 1 : 0;
    const fy1 = flipV ? -1 : 1;
    const offsetX = rect.x - bounds.width / 2 + rect.width * fx0;
    const stepX = rect.width * fx1;
    const offsetY = rect.y - bounds.height / 2 + rect.height * (fy0 + fy1);
    const stepY = -rect.height * fy1;

    return new Float32Array([
      cos * stepX,
      sin * stepX,
      0,
      sin * stepY,
      -cos * stepY,
      0,
      textureWidth / 2 + cos * offsetX + sin * offsetY,
      textureHeight / 2 + sin * offsetX - cos * offsetY,
      1,
    ]);
  }

  /**
   * 输出画布像素（左上角为原点，可传像素中心）→ 源图像素（左上角为原点）。
   */
  function outputToSource(
    textureWidth,
    textureHeight,
    state,
    outputWidth,
    outputHeight,
    x,
    y,
  ) {
    const matrix = viewMatrix(textureWidth, textureHeight, state);
    const s = outputWidth ? x / outputWidth : 0;
    const reverseT = outputHeight ? 1 - y / outputHeight : 0;
    const u = matrix[0] * s + matrix[3] * reverseT + matrix[6];
    const v = matrix[1] * s + matrix[4] * reverseT + matrix[7];

    return { x: u, y: textureHeight - v };
  }

  /**
   * Canvas 2D 的 setTransform 参数：源图像素（左上角为原点）→ 输出画布像素。
   * 与 viewMatrix 是同一组映射，方向相反，供 drawImage 使用，
   * 这样「原图」面板、AI 结果和 WebGL 渲染出来的画面能完全对齐。
   */
  function viewTransform(
    textureWidth,
    textureHeight,
    state,
    outputWidth,
    outputHeight,
  ) {
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

    if (!outputWidth || !outputHeight) {
      return identity;
    }

    const matrix = viewMatrix(textureWidth, textureHeight, state);
    // 输出 → 源的仿射参数（y 相差一次翻转）
    const a = matrix[0] / outputWidth;
    const b = -matrix[3] / outputHeight;
    const c = -matrix[1] / outputWidth;
    const d = matrix[4] / outputHeight;
    const e = matrix[3] + matrix[6];
    const f = textureHeight - matrix[4] - matrix[7];
    const determinant = a * d - b * c;

    if (!determinant) {
      return identity;
    }

    const ia = d / determinant;
    const ib = -c / determinant;
    const ic = -b / determinant;
    const id = a / determinant;

    return {
      a: ia,
      b: ib,
      c: ic,
      d: id,
      e: -(ia * e + ic * f),
      f: -(ib * e + id * f),
    };
  }

  /** 源图像素 → 输出画布像素（上面那个映射的逆，用于把灰点标记画回画面）。 */
  function sourceToOutput(
    textureWidth,
    textureHeight,
    state,
    outputWidth,
    outputHeight,
    x,
    y,
  ) {
    const matrix = viewMatrix(textureWidth, textureHeight, state);
    const m00 = matrix[0];
    const m10 = matrix[1];
    const m01 = matrix[3];
    const m11 = matrix[4];
    const determinant = m00 * m11 - m01 * m10;

    if (!determinant) {
      return null;
    }

    const px = x - matrix[6];
    const py = textureHeight - y - matrix[7];
    const s = (px * m11 - m01 * py) / determinant;
    const reverseT = (m00 * py - px * m10) / determinant;

    return { x: s * outputWidth, y: (1 - reverseT) * outputHeight };
  }

  /** 源图像素是否落在当前画面内（用来判断灰点标记还要不要显示）。 */
  function isSourcePointVisible(
    textureWidth,
    textureHeight,
    state,
    outputWidth,
    outputHeight,
    x,
    y,
  ) {
    const point = sourceToOutput(
      textureWidth,
      textureHeight,
      state,
      outputWidth,
      outputHeight,
      x,
      y,
    );

    if (!point) {
      return false;
    }

    return (
      point.x >= -0.5 &&
      point.y >= -0.5 &&
      point.x <= outputWidth + 0.5 &&
      point.y <= outputHeight + 0.5
    );
  }

  function isCropped(state) {
    const crop = normalizeCrop(state?.crop);

    return (
      Math.abs(crop.x) > 1e-6 ||
      Math.abs(crop.y) > 1e-6 ||
      Math.abs(crop.width - 1) > 1e-6 ||
      Math.abs(crop.height - 1) > 1e-6
    );
  }

  function isIdentity(state) {
    if (!state) {
      return true;
    }

    return (
      Math.abs(totalAngle(state)) < 1e-6 &&
      !state.flipH &&
      !state.flipV &&
      !isCropped(state)
    );
  }

  /** 90° 步进：裁切框跟着画面一起转，避免「转完画面跑出框外」。 */
  function rotateCrop90(crop, step) {
    const safe = normalizeCrop(crop);

    if (step > 0) {
      return normalizeCrop({
        x: 1 - safe.y - safe.height,
        y: safe.x,
        width: safe.height,
        height: safe.width,
      });
    }

    return normalizeCrop({
      x: safe.y,
      y: 1 - safe.x - safe.width,
      width: safe.height,
      height: safe.width,
    });
  }

  function rotateQuarter(state, direction) {
    const step = direction < 0 ? -1 : 1;
    const base = state || createState();

    return {
      ...base,
      quarter: ((((Number(base.quarter) || 0) + step) % 4) + 4) % 4,
      crop: rotateCrop90(base.crop, step),
    };
  }

  function toggleFlip(state, axis) {
    const base = state || createState();

    return axis === "v"
      ? { ...base, flipV: !base.flipV }
      : { ...base, flipH: !base.flipH };
  }

  function aspectRatio(id, frameAspect) {
    if (id === "original") {
      return isFiniteNumber(frameAspect) && frameAspect > 0 ? frameAspect : 1;
    }

    const preset = ASPECTS.find((item) => item.id === id);

    return preset && preset.ratio ? preset.ratio : null;
  }

  /**
   * 按目标比例调整裁切框：保持当前中心与面积，再缩到能放进画面的大小。
   * bounds 是外接矩形尺寸（像素），ratio 是像素宽高比。
   */
  function applyAspect(crop, ratio, bounds) {
    const safe = normalizeCrop(crop);
    const boundsWidth = Math.max(1e-6, Number(bounds?.width) || 0);
    const boundsHeight = Math.max(1e-6, Number(bounds?.height) || 0);
    const target = Number(ratio);

    if (!Number.isFinite(target) || target <= 0) {
      return safe;
    }

    // 归一化空间里的宽高比 = 像素比例 ÷ 画面比例
    const normalizedRatio = target / (boundsWidth / boundsHeight);
    const area = safe.width * safe.height;
    let width = Math.sqrt(area * normalizedRatio);
    let height = width / normalizedRatio;
    const fitWidth = Math.min(1, normalizedRatio);
    const fitHeight = fitWidth / normalizedRatio;
    const scale = Math.min(1, fitWidth / width, fitHeight / height);

    width *= scale;
    height *= scale;

    const centerX = safe.x + safe.width / 2;
    const centerY = safe.y + safe.height / 2;

    return normalizeCrop({
      x: clamp(centerX - width / 2, 0, 1 - width),
      y: clamp(centerY - height / 2, 0, 1 - height),
      width,
      height,
    });
  }

  /**
   * 旋转后画面里能放下的最大同比例矩形。
   *
   * 设旋转角为 θ、原图 w×h，同比例矩形的宽为 X（高为 X/a，a 为宽高比）。
   * 四个角点回到原图坐标系后必须落在 w×h 内，于是 X 必须同时满足
   *   X ≤ w / (cosθ + sinθ/a)      X ≤ w / |cosθ - sinθ/a|
   *   X ≤ h / (sinθ + cosθ/a)      X ≤ h / |cosθ/a - sinθ|
   * 取四者最小值即为最大内接矩形（居中放置）。
   */
  function inscribedRect(width, height, angleDegrees, ratio) {
    const radians = (normalizeAngle(angleDegrees) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    const base = Number(width) / Number(height);
    const candidates = [];
    const preferred = isFiniteNumber(ratio) && ratio > 0 ? ratio : base;

    candidates.push(preferred);

    if (Math.abs(preferred - 1 / preferred) > 1e-9) {
      candidates.push(1 / preferred);
    }

    let best = null;

    for (const candidate of candidates) {
      const limit = Math.min(
        limitFor(width, cos + sin / candidate),
        limitFor(width, Math.abs(cos - sin / candidate)),
        limitFor(height, Math.abs(cos / candidate - sin)),
        limitFor(height, sin + cos / candidate),
      );

      if (!Number.isFinite(limit) || limit <= 0) {
        continue;
      }

      const rectHeight = limit / candidate;
      const area = limit * rectHeight;

      if (!best || area > best.area) {
        best = { width: limit, height: rectHeight, area };
      }
    }

    return best;
  }

  function limitFor(size, coefficient) {
    if (!(Math.abs(coefficient) > 1e-9)) {
      return Infinity;
    }

    return Math.max(0, size) / Math.abs(coefficient);
  }

  /** 自动裁掉空白：把裁切框收成旋转后画面里最大的同比例矩形。 */
  function inscribedCrop(textureWidth, textureHeight, state) {
    const degrees = totalAngle(state);
    const bounds = rotatedBounds(textureWidth, textureHeight, degrees);
    const rect = inscribedRect(
      textureWidth,
      textureHeight,
      degrees,
      textureWidth / textureHeight,
    );

    if (!rect) {
      return normalizeCrop(state?.crop);
    }

    return cropFromRect(bounds, {
      x: (bounds.width - rect.width) / 2,
      y: (bounds.height - rect.height) / 2,
      width: rect.width,
      height: rect.height,
    });
  }

  function formatAngle(degrees) {
    const rounded = Math.round(Number(degrees) * 10) / 10;

    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  /** 参数面板/工具条上显示的一句话摘要。 */
  function describe(state, textureWidth, textureHeight) {
    const parts = [];
    const degrees = totalAngle(state);

    if (Math.abs(degrees) > 1e-6) {
      parts.push(`旋转 ${formatAngle(degrees)}°`);
    }

    if (state?.flipH) {
      parts.push("水平翻转");
    }

    if (state?.flipV) {
      parts.push("垂直翻转");
    }

    if (isCropped(state)) {
      if (textureWidth && textureHeight) {
        const size = viewSize(textureWidth, textureHeight, state);

        parts.push(`裁切 ${size.width} × ${size.height}`);
      } else {
        parts.push("已裁切");
      }
    }

    return parts.length ? parts.join(" · ") : "未调整";
  }

  const CROP_EDGES = Object.freeze(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);

  /**
   * 拖动裁切框：在归一化空间里按住某个手柄 / 框内拖动。
   * handle 取 CROP_EDGES 里的值，"move" 表示整体平移。
   * normalizedRatio 是归一化空间里的宽高比（像素比例 ÷ 画面比例），
   * 为 null 表示不锁定比例。
   */
  function dragCrop(crop, handle, deltaU, deltaV, normalizedRatio) {
    const safe = normalizeCrop(crop);

    if (handle === "move") {
      return normalizeCrop({
        x: safe.x + deltaU,
        y: safe.y + deltaV,
        width: safe.width,
        height: safe.height,
      });
    }

    const left = handle.includes("w");
    const right = handle.includes("e");
    const top = handle.startsWith("n");
    const bottom = handle.startsWith("s");
    const centerX = safe.x + safe.width / 2;
    const centerY = safe.y + safe.height / 2;
    let x0 = safe.x;
    let y0 = safe.y;
    let x1 = safe.x + safe.width;
    let y1 = safe.y + safe.height;

    if (left) {
      x0 = clamp(x0 + deltaU, 0, x1 - MIN_CROP_RATIO);
    }

    if (right) {
      x1 = clamp(x1 + deltaU, x0 + MIN_CROP_RATIO, 1);
    }

    if (top) {
      y0 = clamp(y0 + deltaV, 0, y1 - MIN_CROP_RATIO);
    }

    if (bottom) {
      y1 = clamp(y1 + deltaV, y0 + MIN_CROP_RATIO, 1);
    }

    let width = x1 - x0;
    let height = y1 - y0;
    const ratio = Number(normalizedRatio);

    if (!Number.isFinite(ratio) || ratio <= 0) {
      return normalizeCrop({ x: x0, y: y0, width, height });
    }

    // 锁比例：以拖动的方向为准推导另一条边，再缩回画面内
    if (left || right) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }

    if (width > 1) {
      width = 1;
      height = width / ratio;
    }

    if (height > 1) {
      height = 1;
      width = height * ratio;
    }

    // 角手柄锚在对面角；单边手柄另一轴保持居中
    const nextX = left ? x1 - width : right ? x0 : centerX - width / 2;
    const nextY = top ? y1 - height : bottom ? y0 : centerY - height / 2;

    return normalizeCrop({
      x: clamp(nextX, 0, 1 - width),
      y: clamp(nextY, 0, 1 - height),
      width,
      height,
    });
  }

  return {
    MAX_FINE_ANGLE,
    MIN_CROP_RATIO,
    ASPECTS,
    FULL_CROP,
    CROP_EDGES,
    clamp,
    normalizeAngle,
    createState,
    totalAngle,
    normalizeCrop,
    rotatedBounds,
    cropRect,
    cropFromRect,
    viewSize,
    viewMatrix,
    viewTransform,
    outputToSource,
    sourceToOutput,
    isSourcePointVisible,
    isCropped,
    isIdentity,
    rotateCrop90,
    rotateQuarter,
    toggleFlip,
    aspectRatio,
    applyAspect,
    inscribedRect,
    inscribedCrop,
    dragCrop,
    formatAngle,
    describe,
  };
});
