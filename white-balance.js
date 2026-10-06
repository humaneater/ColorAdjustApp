/**
 * 白平衡（White Balance）色彩科学模块。
 *
 * 本文件把「所有常见的白平衡调整方式」收敛成同一个数学模型：
 * 求出一个线性的 3x3 色适应矩阵，把「假定的光源白点」映射到 sRGB 的参考白点 D65。
 * 不同方式之间的差别只在于「白点从哪里来」：
 *
 *   手动双轴（暖冷 + 绿品红）  → 沿用旧版着色器里的经验公式，不经过矩阵
 *   开尔文色温 + 色调          → 黑体/日光轨迹上的色度点（CIE 1931 xy）
 *   场景预设                   → 预置的 (色温, 色调) 组合
 *   自动分析                   → 从画面像素统计中估计光源色度
 *   灰点拾色                   → 用户点选的中性像素色度
 *   RGB 通道增益               → 相机倍率式的对角矩阵
 *
 * 色温/色调路径的推导：
 *   1. 由相关色温 T 与 Duv 偏移求出光源色度 (x, y)；
 *   2. (x, y) → CIE XYZ → 线性 sRGB，得到光源白点 W；
 *   3. 用显式色适应变换（默认 Bradford）求 W → D65 的 3x3 矩阵；
 *   4. 矩阵作用在线性光下，因此结果对中性色严格成立，对彩色也保持色相。
 *
 * 该文件同时兼容浏览器（挂载 globalThis.ColorWhiteBalance）与 Node（module.exports），
 * 便于用脚本对色彩数学做回归测试。
 */
(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ColorWhiteBalance = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** sRGB → CIE XYZ (D65)，IEC 61966-2-1 官方矩阵。 */
  const SRGB_TO_XYZ = [
    0.41239079926595934, 0.357584339383878, 0.1804807884018343,
    0.21263900587151027, 0.715168678767756, 0.07219231536073371,
    0.01933081871559182, 0.11919477979462598, 0.9505321522496607,
  ];

  /** CIE XYZ (D65) → sRGB。 */
  const XYZ_TO_SRGB = [
    3.2409699419045226, -1.537383177570094, -0.4986107602930034,
    -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
    0.05563007969699366, -0.20397695888897652, 1.0569715142428786,
  ];

  /** sRGB 的参考白点 D65（CIE 1931 xy）。 */
  const D65_XY = [0.3127, 0.329];

  /** CIE 1960 UCS 中的普朗克轨迹点，用于计算 Duv 等温线。 */
  const D65_UV60 = xyToUv60(D65_XY[0], D65_XY[1]);

  /**
   * 显式色适应变换（CAT）使用的锥体响应空间。
   * 参考：Bruce Lindbloom, "Chromatic Adaptation"；CIE 160:2004。
   */
  const CAT_SPACES = Object.freeze({
    xyz: {
      id: "xyz",
      label: "XYZ 缩放（wrong von Kries）",
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    },
    vonKries: {
      id: "vonKries",
      label: "von Kries / HPE 锥体",
      matrix: [
        0.38971, 0.68898, -0.07868,
        -0.22981, 1.1834, 0.04641,
        0.0, 0.0, 1.0,
      ],
    },
    bradford: {
      id: "bradford",
      label: "Bradford",
      matrix: [
        0.8951, 0.2664, -0.1614,
        -0.7502, 1.7135, 0.0367,
        0.0389, -0.0685, 1.0296,
      ],
    },
    sharp: {
      id: "sharp",
      label: "Sharp",
      matrix: [
        1.2694, -0.0988, -0.1706,
        -0.8364, 1.8006, 0.0357,
        0.0297, -0.0315, 1.0018,
      ],
    },
    cmccat2000: {
      id: "cmccat2000",
      label: "CMCCAT2000",
      matrix: [
        0.7982, 0.3389, -0.1371,
        -0.5918, 1.5512, 0.0406,
        0.0008, 0.0239, 0.9753,
      ],
    },
    cat02: {
      id: "cat02",
      label: "CAT02 / CAM16",
      matrix: [
        0.7328, 0.4296, -0.1624,
        -0.7036, 1.6975, 0.0061,
        0.003, 0.0136, 0.9834,
      ],
    },
  });

  /** 默认色适应空间：ICC 与 Adobe DNG 的选择。 */
  const DEFAULT_CAT_SPACE = "bradford";

  /** 色调滑条满量程对应的 Duv 偏移（正值 = 品红，负值 = 绿）。 */
  const TINT_DUV_SCALE = 0.02;

  /** 单个锥体通道允许的最大增益比，仅用于挡住病态输入，不影响 2000K–12000K 的正常范围。 */
  const MAX_CAT_RATIO = 32;

  /**
   * 黑体轨迹与日光轨迹的过渡区间。
   * 两条轨迹在 4000K 附近相差约 0.003 Duv，直接拼接会让色温滑条出现肉眼可见的跳变，
   * 因此在 3400K–4600K 之间用 smoothstep 平滑过渡。
   */
  const LOCUS_BLEND_LOW = 3400;
  const LOCUS_BLEND_HIGH = 4600;

  /** 单通道增益的上下限（约 ±3 EV）。 */
  const MAX_CHANNEL_GAIN = 8;

  /**
   * 场景/相机预设。数值取自相机厂商常见预设与 CIE 标准光源：
   * 日光 D55、阴天、阴影、白炽灯 A、荧光灯 F 系列、闪光灯。
   */
  const WB_PRESETS = Object.freeze([
    { id: "custom", label: "自定义", kelvin: 0, tint: 0 },
    { id: "candle", label: "烛光 / 日出 1900K", kelvin: 1900, tint: 0 },
    { id: "incandescent", label: "白炽灯 2856K", kelvin: 2856, tint: 0 },
    { id: "fluorescentWarm", label: "暖白荧光灯 3000K", kelvin: 3000, tint: 10 },
    { id: "tungstenStudio", label: "影室灯 3200K", kelvin: 3200, tint: 0 },
    { id: "fluorescentCool", label: "冷白荧光灯 4200K", kelvin: 4200, tint: 14 },
    { id: "daylight", label: "日光 5200K", kelvin: 5200, tint: 0 },
    { id: "flash", label: "电子闪光灯 5500K", kelvin: 5500, tint: 0 },
    { id: "cloudy", label: "阴天 6000K", kelvin: 6000, tint: 0 },
    { id: "daylightFluorescent", label: "日光荧光灯 6500K", kelvin: 6500, tint: 12 },
    { id: "shade", label: "阴影 7000K", kelvin: 7000, tint: 0 },
    { id: "blueSky", label: "蓝天 / 雪地 10000K", kelvin: 10000, tint: 0 },
  ]);

  /**
   * 自动白平衡（光源估计）算法。
   * 参考：Gijsenij, Gevers, van de Weijer, "Computational Color Constancy:
   * Survey and Experiments" (IEEE TIP 2011)；Finlayson & Trezzi,
   * "Shades of Gray and Colour Constancy" (2004)。
   */
  const AUTO_ALGORITHMS = Object.freeze([
    {
      id: "grayWorld",
      label: "灰度世界",
      hint: "假设整幅画面的平均反射率是中性灰，用各通道均值估计光源（Gijsenij 分类中的统计型，等价于 p=1 的 Shades of Gray）",
    },
    {
      id: "shadesOfGray",
      label: "Shades of Gray (p=6)",
      hint: "Minkowski 范数 p=6 的灰度世界推广，对大面积单色场景比灰度世界稳健",
    },
    {
      id: "whitePatch",
      label: "白点 / Max-RGB",
      hint: "假设画面中存在白色（全反射）物体，用各通道最大值作为光源（Land 的 Retinex 白点假设）",
    },
    {
      id: "percentileWhite",
      label: "白点分位数 97%",
      hint: "用各通道 97% 分位数代替最大值，抑制高光噪点与单点反光造成的偏差",
    },
    {
      id: "grayEdge",
      label: "灰度边缘",
      hint: "假设场景中边缘处的平均反射率是中性的，用一阶空间导数的均值估计光源（van de Weijer 的灰度边缘）",
    },
  ]);

  /** 白平衡方式（下拉菜单的选项）。 */
  const WB_MODES = Object.freeze([
    { id: "manual", label: "手动双轴（暖冷 / 绿品红）", controls: ["temperature", "whiteBalance"] },
    { id: "kelvin", label: "色温 + 色调（开尔文）", controls: ["wbKelvin", "wbTint"] },
    {
      id: "preset",
      label: "场景预设（日光 / 阴天 / 白炽灯…）",
      controls: ["wbPreset", "wbKelvin", "wbTint"],
    },
    {
      id: "auto",
      label: "自动分析（灰度世界等）",
      controls: ["wbAlgorithm", "wbStrength"],
    },
    {
      id: "grayPoint",
      label: "灰点拾色（点击中性区域）",
      controls: ["wbStrength"],
    },
    {
      id: "gains",
      label: "RGB 通道增益（相机倍率）",
      controls: ["wbGainR", "wbGainG", "wbGainB"],
    },
    { id: "off", label: "关闭白平衡", controls: [] },
  ]);

  /* ------------------------------------------------------------------ *
   * 线性代数：3x3 矩阵一律使用行优先的一维数组 [m00..m22]
   * ------------------------------------------------------------------ */

  function identity3() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  /** a * b。 */
  function multiply3(a, b) {
    const out = new Array(9);

    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        out[row * 3 + column] =
          a[row * 3] * b[column] +
          a[row * 3 + 1] * b[3 + column] +
          a[row * 3 + 2] * b[6 + column];
      }
    }

    return out;
  }

  function apply3(matrix, vector) {
    return [
      matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
      matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
      matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
    ];
  }

  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const determinant =
      a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);

    if (Math.abs(determinant) < 1e-12) {
      throw new Error("矩阵不可逆");
    }

    const scale = 1 / determinant;

    return [
      (e * i - f * h) * scale,
      (c * h - b * i) * scale,
      (b * f - c * e) * scale,
      (f * g - d * i) * scale,
      (a * i - c * g) * scale,
      (c * d - a * f) * scale,
      (d * h - e * g) * scale,
      (b * g - a * h) * scale,
      (a * e - b * d) * scale,
    ];
  }

  function diagonalMatrix(r, g, b) {
    return [r, 0, 0, 0, g, 0, 0, 0, b];
  }

  /** 在单位矩阵与 matrix 之间线性插值：strength=0 → 不调整。 */
  function blendWithIdentity(matrix, strength) {
    const t = Math.max(0, Math.min(1, Number(strength)));

    if (t >= 1) {
      return matrix.slice();
    }

    const out = new Array(9);

    for (let index = 0; index < 9; index += 1) {
      const base = index % 4 === 0 ? 1 : 0;

      out[index] = base + (matrix[index] - base) * t;
    }

    return out;
  }

  /** GLSL 的 mat3 是列优先，WebGL 上传时需要转置存储顺序。 */
  function toColumnMajor(matrix) {
    return new Float32Array([
      matrix[0], matrix[3], matrix[6],
      matrix[1], matrix[4], matrix[7],
      matrix[2], matrix[5], matrix[8],
    ]);
  }

  function maxAbsDifference(a, b) {
    let difference = 0;

    for (let index = 0; index < 9; index += 1) {
      difference = Math.max(difference, Math.abs(a[index] - b[index]));
    }

    return difference;
  }

  /* ------------------------------------------------------------------ *
   * 色度学基础
   * ------------------------------------------------------------------ */

  function srgbToLinear(value) {
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(value) {
    if (value <= 0) {
      return 0;
    }

    return value <= 0.0031308
      ? value * 12.92
      : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  }

  function srgbTripletToLinear(rgb) {
    return [
      srgbToLinear(rgb[0]),
      srgbToLinear(rgb[1]),
      srgbToLinear(rgb[2]),
    ];
  }

  /** 线性 sRGB → CIE XYZ。 */
  function linearRgbToXyz(rgb) {
    return apply3(SRGB_TO_XYZ, rgb);
  }

  /** CIE XYZ → 线性 sRGB。 */
  function xyzToLinearRgb(xyz) {
    return apply3(XYZ_TO_SRGB, xyz);
  }

  /** 线性 sRGB → xy 色度（Y=1 归一化）。 */
  function linearRgbToXy(rgb) {
    return xyzToXy(linearRgbToXyz(rgb));
  }

  /** xy 色度 → 线性 sRGB（Y=1）。 */
  function xyToLinearRgb(x, y) {
    return xyzToLinearRgb(xyToXyz(x, y));
  }

  function xyToXyz(x, y) {
    const safeY = Math.max(1e-6, y);

    return [x / safeY, 1, (1 - x - y) / safeY];
  }

  function xyzToXy(xyz) {
    const sum = xyz[0] + xyz[1] + xyz[2];

    if (Math.abs(sum) < 1e-12) {
      return [D65_XY[0], D65_XY[1]];
    }

    return [xyz[0] / sum, xyz[1] / sum];
  }

  function xyToUv60(x, y) {
    const denominator = -2 * x + 12 * y + 3;

    if (Math.abs(denominator) < 1e-12) {
      return [0, 0];
    }

    return [(4 * x) / denominator, (6 * y) / denominator];
  }

  function uv60ToXy(u, v) {
    const denominator = 2 * u - 8 * v + 4;

    if (Math.abs(denominator) < 1e-12) {
      return [D65_XY[0], D65_XY[1]];
    }

    return [(3 * u) / denominator, (2 * v) / denominator];
  }

  function normalizeTriplet(triplet) {
    const reference = triplet[1] > 1e-6 ? triplet[1] : 1;

    return [triplet[0] / reference, triplet[1] / reference, triplet[2] / reference];
  }

  /** 把归一化后的三元组包装成光源对象。 */
  function asIlluminant(triplet) {
    const normalized = normalizeTriplet(triplet);

    return { r: normalized[0], g: normalized[1], b: normalized[2] };
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  /* ------------------------------------------------------------------ *
   * 色温 → 色度：普朗克轨迹（黑体）与 CIE 日光轨迹
   * ------------------------------------------------------------------ */

  /**
   * 黑体（普朗克）轨迹 xy 近似，Kim et al. 1999 / CIE 推荐式，1667K–25000K。
   */
  function planckianXy(kelvin) {
    const temperature = clamp(kelvin, 1667, 25000);
    const inverse = 1000 / temperature;
    let x;

    if (temperature <= 4000) {
      x =
        -0.2661239 * inverse * inverse * inverse -
        0.2343589 * inverse * inverse +
        0.8776956 * inverse +
        0.17991;
    } else {
      x =
        -3.0258469 * inverse * inverse * inverse +
        2.1070379 * inverse * inverse +
        0.2226347 * inverse +
        0.24039;
    }

    let y;

    if (temperature <= 2222) {
      y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683;
    } else if (temperature <= 4000) {
      y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
    } else {
      y = 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
    }

    return [x, y];
  }

  /** CIE 日光轨迹（D 系列）xy，4000K–25000K。 */
  function daylightXy(kelvin) {
    const temperature = clamp(kelvin, 4000, 25000);
    const inverse = 1000 / temperature;
    let x;

    if (temperature <= 7000) {
      x =
        -4.607 * inverse * inverse * inverse +
        2.9678 * inverse * inverse +
        0.09911 * inverse +
        0.244063;
    } else {
      x =
        -2.0064 * inverse * inverse * inverse +
        1.9018 * inverse * inverse +
        0.24748 * inverse +
        0.23704;
    }

    const y = -3.0 * x * x + 2.87 * x - 0.275;

    return [x, y];
  }

  /**
   * 色温 → 轨迹上的 xy。
   *
   * @param {number} kelvin 相关色温
   * @param {string} [locus] "auto"（默认，低温段黑体 + 高温段日光，中间平滑过渡）、
   *                         "planck" 或 "daylight"
   */
  function locusXy(kelvin, locus = "auto") {
    const temperature = clamp(kelvin, 1667, 25000);

    if (locus === "planck") {
      return planckianXy(temperature);
    }

    if (locus === "daylight") {
      return daylightXy(temperature);
    }

    if (temperature <= LOCUS_BLEND_LOW) {
      return planckianXy(temperature);
    }

    if (temperature >= LOCUS_BLEND_HIGH) {
      return daylightXy(temperature);
    }

    const position =
      (temperature - LOCUS_BLEND_LOW) / (LOCUS_BLEND_HIGH - LOCUS_BLEND_LOW);
    const weight = position * position * (3 - 2 * position);
    const planck = planckianXy(temperature);
    const daylight = daylightXy(temperature);

    return [
      planck[0] + (daylight[0] - planck[0]) * weight,
      planck[1] + (daylight[1] - planck[1]) * weight,
    ];
  }

  /** 轨迹在给定色温处的单位法线（指向偏绿一侧）。 */
  function locusNormal(kelvin, locus = "auto") {
    const step = Math.max(1, kelvin * 0.002);
    const [u, v] = xyToUv60(...locusXy(kelvin, locus));
    const [nextU, nextV] = xyToUv60(...locusXy(kelvin + step, locus));
    let tangentU = nextU - u;
    let tangentV = nextV - v;
    const length = Math.hypot(tangentU, tangentV) || 1;

    tangentU /= length;
    tangentV /= length;

    // 法线取 v 增大（偏绿）的方向，与 Duv 的正负定义一致。
    let normalU = -tangentV;
    let normalV = tangentU;

    if (normalV < 0) {
      normalU = -normalU;
      normalV = -normalV;
    }

    return [normalU, normalV];
  }

  /**
   * 色温 + 色调 → xy。
   *
   * @param {number} kelvin 相关色温
   * @param {number} duv    与轨迹的垂直距离，正值为偏绿，负值为偏品红
   * @param {string} [locus] 见 locusXy()
   */
  function cctToXy(kelvin, duv = 0, locus = "auto") {
    const temperature = clamp(kelvin, 1667, 25000);
    const [x, y] = locusXy(temperature, locus);

    if (Math.abs(duv) < 1e-12) {
      return [x, y];
    }

    // 在 CIE 1960 uv 图上沿等温线的法线方向偏移 Duv。
    const [u, v] = xyToUv60(x, y);
    const [normalU, normalV] = locusNormal(temperature, locus);

    return uv60ToXy(u + duv * normalU, v + duv * normalV);
  }

  /**
   * xy → 相关色温与 Duv（在 CIE 1960 uv 图上求到轨迹的最近点）。
   *
   * 先用 McCamy 近似定位，再在 uv 距离上做三分搜索细化，
   * 因此结果与 cctToXy() 使用同一条轨迹，可以和色温滑条直接互换。
   *
   * @returns {{kelvin: number, duv: number, tint: number, valid: boolean}}
   */
  function xyToCct(x, y, locus = "auto") {
    const target = xyToUv60(x, y);
    const distanceAt = (kelvin) => {
      const [u, v] = xyToUv60(...locusXy(kelvin, locus));

      return Math.hypot(u - target[0], v - target[1]);
    };
    let bestKelvin = 6500;
    let bestDistance = Infinity;
    const scanCount = 240;

    for (let index = 0; index <= scanCount; index += 1) {
      const kelvin = 1200 * Math.pow(25000 / 1200, index / scanCount);
      const distance = distanceAt(kelvin);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestKelvin = kelvin;
      }
    }

    let low = bestKelvin * 0.9;
    let high = bestKelvin * 1.1;

    for (let index = 0; index < 80; index += 1) {
      const first = low + (high - low) / 3;
      const second = high - (high - low) / 3;

      if (distanceAt(first) < distanceAt(second)) {
        high = second;
      } else {
        low = first;
      }
    }

    const kelvin = (low + high) / 2;
    const [u, v] = xyToUv60(...locusXy(kelvin, locus));
    const [normalU, normalV] = locusNormal(kelvin, locus);
    const duv = (target[0] - u) * normalU + (target[1] - v) * normalV;
    const valid =
      Number.isFinite(kelvin) && kelvin >= 1200 && kelvin <= 25000 && Math.abs(duv) <= 0.05;

    return {
      kelvin: valid ? kelvin : 0,
      duv: valid ? duv : 0,
      tint: valid ? (duv * 100) / TINT_DUV_SCALE : 0,
      valid,
    };
  }

  /* ------------------------------------------------------------------ *
   * 色适应变换
   * ------------------------------------------------------------------ */

  /**
   * 求把 fromXy 白点映射到 toXy 白点的 XYZ 色适应矩阵（von Kries 型）。
   */
  function chromaticAdaptation(fromXy, toXy, spaceId = DEFAULT_CAT_SPACE, maxRatio = MAX_CAT_RATIO) {
    const space = CAT_SPACES[spaceId] || CAT_SPACES[DEFAULT_CAT_SPACE];
    const cone = space.matrix;
    const coneInverse = invert3(cone);
    const source = apply3(cone, xyToXyz(fromXy[0], fromXy[1]));
    const destination = apply3(cone, xyToXyz(toXy[0], toXy[1]));
    const ratios = new Array(3);

    for (let index = 0; index < 3; index += 1) {
      const denominator = Math.abs(source[index]) < 1e-9 ? 1e-9 : source[index];

      ratios[index] = clamp(
        destination[index] / denominator,
        1 / maxRatio,
        maxRatio,
      );
    }

    return multiply3(
      coneInverse,
      multiply3(diagonalMatrix(ratios[0], ratios[1], ratios[2]), cone),
    );
  }

  /** 把 XYZ 空间的矩阵转换成线性 sRGB 空间的矩阵。 */
  function xyzMatrixToLinearRgb(matrix) {
    return multiply3(XYZ_TO_SRGB, multiply3(matrix, SRGB_TO_XYZ));
  }

  /**
   * 由「假定光源」的 xy 色度求白平衡矩阵（线性 sRGB 空间）。
   */
  function matrixFromIlluminantXy(illuminantXy, options = {}) {
    const adaptation = chromaticAdaptation(
      illuminantXy,
      options.targetXy || D65_XY,
      options.catSpace || DEFAULT_CAT_SPACE,
      options.maxRatio || MAX_CAT_RATIO,
    );

    return xyzMatrixToLinearRgb(adaptation);
  }

  /** 由线性 sRGB 表示的光源颜色求白平衡矩阵。 */
  function matrixFromLinearRgb(linearRgb, options = {}) {
    return matrixFromIlluminantXy(linearRgbToXy(linearRgb), options);
  }

  /** 由色温与色调求白平衡矩阵。 */
  function matrixFromKelvin(kelvin, tint, options = {}) {
    const duv = tintToDuv(tint);

    return matrixFromIlluminantXy(cctToXy(kelvin, duv, options.locus), options);
  }

  /** RGB 通道增益（相机倍率）→ 对角矩阵，按绿色通道归一化以保持亮度。 */
  function matrixFromChannelGains(gains) {
    const green = Math.abs(gains[1]) < 1e-6 ? 1 : gains[1];

    return diagonalMatrix(
      clamp(gains[0] / green, 1 / MAX_CHANNEL_GAIN, MAX_CHANNEL_GAIN),
      1,
      clamp(gains[2] / green, 1 / MAX_CHANNEL_GAIN, MAX_CHANNEL_GAIN),
    );
  }

  /**
   * 色调滑条（-100..100）→ 光源的 Duv 偏移。
   *
   * 滑条方向与 Lightroom / Camera Raw 一致：正值让画面偏品红，负值让画面偏绿。
   * 画面偏品红意味着「假定的光源偏绿」，所以 Duv 取正号（Duv 的正方向是偏绿）。
   */
  function tintToDuv(tint) {
    return (clamp(Number(tint) || 0, -100, 100) / 100) * TINT_DUV_SCALE;
  }

  /* ------------------------------------------------------------------ *
   * 光源估计（自动白平衡算法）
   * ------------------------------------------------------------------ */

  /**
   * 把 8 位 sRGB 像素转成线性光的分析缓冲。
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba 长度 = width * height * 4
   * @returns {{data: Float32Array, width: number, height: number, count: number}}
   */
  function createAnalysisBuffer(rgba, width, height) {
    const pixelCount = Math.max(0, width * height);
    const data = new Float32Array(pixelCount * 3);
    let kept = 0;

    for (let index = 0; index < pixelCount; index += 1) {
      const source = index * 4;

      if (rgba.length < source + 4) {
        break;
      }

      if (rgba[source + 3] < 8) {
        continue;
      }

      data[kept * 3] = srgbToLinear(rgba[source] / 255);
      data[kept * 3 + 1] = srgbToLinear(rgba[source + 1] / 255);
      data[kept * 3 + 2] = srgbToLinear(rgba[source + 2] / 255);
      kept += 1;
    }

    return {
      data,
      width,
      height,
      count: kept,
    };
  }

  function channelStats(buffer) {
    const { data, count } = buffer;
    const sums = [0, 0, 0];
    const maxima = [0, 0, 0];
    const samples = [[], [], []];

    for (let index = 0; index < count; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = data[index * 3 + channel];

        sums[channel] += value;
        maxima[channel] = Math.max(maxima[channel], value);
        samples[channel].push(value);
      }
    }

    return { sums, maxima, samples, count };
  }

  function meanTriplet(sums, count) {
    const safeCount = count > 0 ? count : 1;

    return [sums[0] / safeCount, sums[1] / safeCount, sums[2] / safeCount];
  }

  function percentile(sorted, ratio) {
    if (sorted.length === 0) {
      return 0;
    }

    const position = clamp(ratio, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(sorted.length - 1, lower + 1);
    const fraction = position - lower;

    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
  }

  /**
   * 估计光源的线性 sRGB 颜色（绿色通道归一化为 1）。
   *
   * @param {{data: Float32Array, width: number, height: number, count: number}} buffer
   * @param {string} algorithm AUTO_ALGORITHMS 中的 id
   * @returns {{r: number, g: number, b: number}}
   */
  function estimateIlluminant(buffer, algorithm = "grayWorld") {
    if (!buffer || !buffer.count) {
      return { r: 1, g: 1, b: 1 };
    }

    const stats = channelStats(buffer);
    let triplet;

    if (algorithm === "whitePatch") {
      triplet = stats.maxima;
    } else if (algorithm === "percentileWhite") {
      triplet = stats.samples.map((channel) =>
        percentile(Float64Array.from(channel).sort(), 0.97),
      );
    } else if (algorithm === "shadesOfGray") {
      const exponent = 6;
      const values = [0, 0, 0];

      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;

        for (let index = 0; index < buffer.count; index += 1) {
          sum += Math.pow(buffer.data[index * 3 + channel], exponent);
        }

        values[channel] = Math.pow(sum / buffer.count, 1 / exponent);
      }

      triplet = values;
    } else if (algorithm === "grayEdge") {
      const { data, width, height, count } = buffer;
      const sums = [0, 0, 0];
      let samples = 0;

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;

          if (index >= count) {
            break;
          }

          if (x + 1 < width && index + 1 < count) {
            for (let channel = 0; channel < 3; channel += 1) {
              sums[channel] += Math.abs(
                data[(index + 1) * 3 + channel] - data[index * 3 + channel],
              );
            }

            samples += 1;
          }

          const below = index + width;

          if (y + 1 < height && below < count) {
            for (let channel = 0; channel < 3; channel += 1) {
              sums[channel] += Math.abs(
                data[below * 3 + channel] - data[index * 3 + channel],
              );
            }

            samples += 1;
          }
        }
      }

      triplet =
        samples === 0
          ? meanTriplet(stats.sums, stats.count)
          : [sums[0] / samples, sums[1] / samples, sums[2] / samples];
    } else {
      // grayWorld：灰度世界假设，等价于 p=1 的 Shades of Gray
      triplet = meanTriplet(stats.sums, stats.count);
    }

    return asIlluminant(triplet);
  }

  /* ------------------------------------------------------------------ *
   * 高层入口：把界面状态解析成着色器可用的矩阵
   * ------------------------------------------------------------------ */

  function findPreset(presetId) {
    return WB_PRESETS.find((preset) => preset.id === presetId) || WB_PRESETS[0];
  }

  /**
   * 通道增益滑条（-100..100）→ 倍率：0 表示 1.0×，±100 表示 ±2 EV（4× / 0.25×）。
   */
  function gainSliderToFactor(value) {
    return Math.pow(2, clamp(Number(value) || 0, -100, 100) / 50);
  }

  function defaultWhiteBalanceState() {
    return {
      mode: "manual",
      kelvin: 6500,
      tint: 0,
      preset: "daylight",
      algorithm: "grayWorld",
      strength: 100,
      catSpace: DEFAULT_CAT_SPACE,
      gains: { r: 0, g: 0, b: 0 },
      sample: null,
    };
  }

  /**
   * 由界面状态求白平衡矩阵。
   *
   * @param {object} state 见 defaultWhiteBalanceState()
   * @param {object|null} analysis createAnalysisBuffer() 的结果，自动模式需要
   * @returns {{enabled: boolean, mode: string, matrix: number[], columnMajor: Float32Array,
   *            illuminantXy: number[]|null, effectiveKelvin: number, equivalentTint: number,
   *            detail: string}}
   */
  function resolve(state, analysis) {
    const current = { ...defaultWhiteBalanceState(), ...(state || {}) };
    const identity = identity3();
    const result = {
      enabled: false,
      mode: current.mode,
      matrix: identity,
      columnMajor: toColumnMajor(identity),
      illuminantXy: null,
      effectiveKelvin: 0,
      equivalentTint: 0,
      detail: "",
    };

    if (current.mode === "off" || current.mode === "manual") {
      result.detail = current.mode === "off" ? "关闭" : "手动双轴";
      return result;
    }

    const strength = clamp(Number(current.strength), 0, 100) / 100;
    let matrix = identity;

    if (current.mode === "gains") {
      const factors = [
        gainSliderToFactor(current.gains.r),
        gainSliderToFactor(current.gains.g),
        gainSliderToFactor(current.gains.b),
      ];

      matrix = matrixFromChannelGains(factors);
      // 增益模式下「假定的光源」是增益的倒数
      result.illuminantXy = linearRgbToXy(
        normalizeTriplet([1 / factors[0], 1 / factors[1], 1 / factors[2]]),
      );
      result.detail = `R ${factors[0].toFixed(2)}× G ${factors[1].toFixed(2)}× B ${factors[2].toFixed(2)}×`;
    } else if (current.mode === "grayPoint") {
      if (!current.sample) {
        result.detail = "尚未拾取灰点";
        return result;
      }

      const sample = normalizeTriplet([
        Math.max(1e-4, current.sample.r),
        Math.max(1e-4, current.sample.g),
        Math.max(1e-4, current.sample.b),
      ]);

      matrix = matrixFromLinearRgb(sample, { catSpace: current.catSpace });
      result.illuminantXy = linearRgbToXy(sample);
      result.detail = `取样点 R${Math.round(current.sample.r * 255)} G${Math.round(current.sample.g * 255)} B${Math.round(current.sample.b * 255)}`;
    } else if (current.mode === "auto") {
      if (!analysis || !analysis.count) {
        result.detail = "等待画面分析";
        return result;
      }

      const illuminant = estimateIlluminant(analysis, current.algorithm);
      const safe = normalizeTriplet([
        Math.max(1e-4, illuminant.r),
        Math.max(1e-4, illuminant.g),
        Math.max(1e-4, illuminant.b),
      ]);

      matrix = matrixFromLinearRgb(safe, { catSpace: current.catSpace });
      result.illuminantXy = linearRgbToXy(safe);
      result.detail = AUTO_ALGORITHMS.find((item) => item.id === current.algorithm)?.label || "";
    } else {
      // kelvin / preset：两者共用色温与色调参数
      const kelvin = clamp(Number(current.kelvin) || 6500, 2000, 12000);
      const duv = tintToDuv(current.tint);

      matrix = matrixFromIlluminantXy(cctToXy(kelvin, duv), {
        catSpace: current.catSpace,
      });
      result.illuminantXy = cctToXy(kelvin, duv);
      result.effectiveKelvin = kelvin;
      result.equivalentTint = clamp(Math.round(Number(current.tint) || 0), -100, 100);
      result.detail = `${Math.round(kelvin)}K${current.tint ? ` / 色调 ${current.tint > 0 ? "+" : ""}${Math.round(current.tint)}` : ""}`;
    }

    if (strength < 1) {
      matrix = blendWithIdentity(matrix, strength);
    }

    // 数值兜底：任何非有限值都退化为「不调整」，避免把画面染成 NaN。
    if (!matrix.every((value) => Number.isFinite(value))) {
      matrix = identity;
    }

    if (maxAbsDifference(matrix, identity) < 1e-6) {
      result.matrix = identity;
      result.columnMajor = toColumnMajor(identity);
      result.detail = result.detail ? `${result.detail}（无变化）` : "无变化";
      return result;
    }

    if (result.illuminantXy) {
      // 把估计出的光源换算成「色温 + 色调」，方便用户切到色温模式复现同样的效果。
      const estimate = xyToCct(
        result.illuminantXy[0],
        result.illuminantXy[1],
        "auto",
      );

      if (estimate.valid) {
        result.effectiveKelvin = Math.round(estimate.kelvin);
        result.equivalentTint = Math.round(clamp(estimate.tint, -100, 100));
      }
    }

    result.enabled = true;
    result.matrix = matrix;
    result.columnMajor = toColumnMajor(matrix);
    return result;
  }

  return {
    // 常量与元数据
    SRGB_TO_XYZ,
    XYZ_TO_SRGB,
    D65_XY,
    D65_UV60,
    CAT_SPACES,
    DEFAULT_CAT_SPACE,
    TINT_DUV_SCALE,
    WB_PRESETS,
    WB_MODES,
    AUTO_ALGORITHMS,
    // 线性代数
    identity3,
    multiply3,
    apply3,
    invert3,
    diagonalMatrix,
    blendWithIdentity,
    toColumnMajor,
    maxAbsDifference,
    // 色度学
    srgbToLinear,
    linearToSrgb,
    srgbTripletToLinear,
    linearRgbToXyz,
    xyzToLinearRgb,
    linearRgbToXy,
    xyToLinearRgb,
    xyToXyz,
    xyzToXy,
    xyToUv60,
    uv60ToXy,
    planckianXy,
    daylightXy,
    locusXy,
    locusNormal,
    cctToXy,
    xyToCct,
    chromaticAdaptation,
    xyzMatrixToLinearRgb,
    matrixFromIlluminantXy,
    matrixFromLinearRgb,
    matrixFromKelvin,
    matrixFromChannelGains,
    tintToDuv,
    gainSliderToFactor,
    // 光源估计
    createAnalysisBuffer,
    estimateIlluminant,
    // 高层入口
    findPreset,
    defaultWhiteBalanceState,
    resolve,
  };
});
