/**
 * 色调分离（Posterize）模型。
 *
 * 把连续的明暗压成有限段平涂色块，用于波普 / 海报风格。两种模式：
 *
 *   luma      按亮度：只把亮度量化到 N 段，再按比例缩放 RGB，
 *             因此色相和饱和度保留，画面变成"色块化"的彩色平涂；
 *   channels  按通道：R/G/B 各自独立量化（Photoshop「色调分离」的做法），
 *             每个通道可以单独开关，做出偏色、双色调之类的效果。
 *
 * 分级公式与着色器里的实现完全一致：
 *   band(x) = round(x * (N - 1)) / (N - 1)
 * 因此 0 与 1 始终映射到自身，黑白场不会被破坏。
 *
 * 兼容浏览器（globalThis.ColorPosterize）与 Node（module.exports），便于测试。
 */
(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ColorPosterize = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** 级数范围：2 级是黑白二值，32 级已经很接近连续。 */
  const MIN_LEVELS = 2;
  const MAX_LEVELS = 32;
  const DEFAULT_LEVELS = 8;
  /** 默认强度为 0：打开工具时画面保持原样，避免"载入图片就被改色"。 */
  const DEFAULT_AMOUNT = 0;
  /** 打开色调分离窗口（或窗口内点重置）时使用的强度。 */
  const ACTIVE_AMOUNT = 100;

  /** 分离模式。 */
  const MODES = Object.freeze([
    { id: "luma", label: "按亮度（保留色彩）" },
    { id: "channels", label: "按通道（R/G/B 各自）" },
  ]);

  /** 单通道开关。 */
  const CHANNELS = Object.freeze([
    { id: "r", label: "R", color: "#ff6b5e" },
    { id: "g", label: "G", color: "#5ed17a" },
    { id: "b", label: "B", color: "#5f9bff" },
  ]);

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function createState() {
    return {
      enabled: false,
      levels: DEFAULT_LEVELS,
      amount: DEFAULT_AMOUNT,
      mode: MODES[0].id,
      channels: { r: true, g: true, b: true },
    };
  }

  /**
   * 默认的「已生效」状态：8 级、100%、按亮度。
   * 打开窗口时若还没有效果就用它，让用户点一下就能看到变化。
   */
  function createActiveState() {
    return { ...createState(), enabled: true, amount: ACTIVE_AMOUNT };
  }

  /**
   * 把一个 0..1 的值量化到 N 段。
   *
   * @param {number} value 0..1
   * @param {number} levels 段数（2..32）
   */
  function quantize(value, levels) {
    const steps = Math.max(MIN_LEVELS, Math.round(Number(levels) || DEFAULT_LEVELS));
    const safe = clamp(Number(value) || 0, 0, 1);

    return Math.round(safe * (steps - 1)) / (steps - 1);
  }

  /**
   * 把界面状态解析成着色器 uniform。
   *
   * 入参是「可编辑状态」（级数为整数、强度为百分数、mode 为字符串），
   * 与 resolve 的返回值不同：返回值只用于上传 uniform 和显示。
   *
   * enabled 是列表里的开关勾选框：关掉时保留全部参数，只是不作用到画面上，
   * 方便和原图来回对比。
   *
   * @returns {{enabled: boolean, levels: number, amount: number, mode: number,
   *            channels: number[], modeId: string}}
   */
  function resolve(state) {
    const current = { ...createState(), ...(state || {}) };
    const channels = current.channels || {};
    const flags = CHANNELS.map((channel) => (channels[channel.id] ? 1 : 0));
    const levels = clamp(
      Math.round(Number(current.levels) || DEFAULT_LEVELS),
      MIN_LEVELS,
      MAX_LEVELS,
    );
    const amount = clamp((Number(current.amount) || 0) / 100, 0, 1);
    const modeId = MODES.some((mode) => mode.id === current.mode)
      ? current.mode
      : MODES[0].id;
    const mode = modeId === "channels" ? 1 : 0;
    const enabled =
      Boolean(current.enabled) &&
      amount > 0.0001 &&
      (mode === 0 || flags.some(Boolean));

    return { enabled, levels, amount, mode, channels: flags, modeId };
  }

  /** 状态摘要，显示在窗口底部与列表行里。 */
  function describe(state) {
    const current = { ...createState(), ...(state || {}) };
    const resolved = resolve(current);

    if (!current.enabled) {
      return "已关闭";
    }

    if (!resolved.enabled) {
      return resolved.amount <= 0.0001 ? "强度 0，不生效" : "未选择任何通道";
    }

    const mode = MODES.find((item) => item.id === resolved.modeId);
    const active = CHANNELS.filter((channel, index) => resolved.channels[index])
      .map((channel) => channel.label)
      .join("+");
    const suffix =
      resolved.modeId === "channels"
        ? ` · ${active}`
        : ` · ${mode ? mode.label : ""}`;

    return `${resolved.levels} 级 · ${Math.round(resolved.amount * 100)}%${suffix}`;
  }

  /**
   * 生成预览条上某一点的颜色。
   *
   * @param {number} position 0..1 横向位置（相当于输入明暗）
   * @param {string} key "luma" 或 "r" / "g" / "b"
   * @param {boolean} enabled 该通道是否参与分离
   */
  function previewColor(position, key, enabled, levels) {
    const banded = enabled ? quantize(position, levels) : clamp(position, 0, 1);
    const value = Math.round(banded * 255);

    if (key === "r") {
      return `rgb(${value},${Math.round(value * 0.22)},${Math.round(value * 0.22)})`;
    }

    if (key === "g") {
      return `rgb(${Math.round(value * 0.22)},${value},${Math.round(value * 0.22)})`;
    }

    if (key === "b") {
      return `rgb(${Math.round(value * 0.22)},${Math.round(value * 0.22)},${value})`;
    }

    return `rgb(${value},${value},${value})`;
  }

  return {
    MIN_LEVELS,
    MAX_LEVELS,
    DEFAULT_LEVELS,
    DEFAULT_AMOUNT,
    ACTIVE_AMOUNT,
    MODES,
    CHANNELS,
    clamp,
    createState,
    createActiveState,
    quantize,
    resolve,
    describe,
    previewColor,
  };});
