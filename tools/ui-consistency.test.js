/**
 * 界面接线一致性测试。
 *
 * app.js 是浏览器 IIFE，无法在 Node 里直接运行，所以这里用静态检查确保：
 *   1. app.js 里写死的 #id 选择器在 index.html 中都存在；
 *   2. 每个滑条（含白平衡新增的滑条）都有 input / output / data-key 三件套；
 *   3. 两个脚本里的白平衡方式、场景预设、自动算法与 index.html 下拉菜单完全一致；
 *   4. 每种白平衡方式显示的行，正好是 white-balance.js 中该方式声明的参数。
 *
 * 运行：node tools/ui-consistency.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const wb = require("../white-balance.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const curves = require("../curves.js");
const posterize = require("../posterize.js");
const geometry = require("../geometry.js");

const browserCheck = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "browser-check.html"), "utf8");
  } catch {
    return "";
  }
})();

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

function extractStringArray(source, name) {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(source);

  assert.ok(match, `app.js 中找不到 ${name}`);

  return Array.from(match[1].matchAll(/"([^"]+)"/g)).map((item) => item[1]);
}

function htmlIds() {
  return new Set(
    Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((match) => match[1]),
  );
}

function selectOptions(id) {
  const match = new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`).exec(html);

  assert.ok(match, `index.html 中找不到下拉菜单 #${id}`);

  return Array.from(
    match[1].matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g),
  ).map((item) => ({ value: item[1], label: item[2].trim() }));
}

function attributes(name) {
  return Array.from(html.matchAll(new RegExp(`\\s${name}="([^"]+)"`, "g"))).map(
    (match) => match[1],
  );
}

/** 取出某个 <dialog> 内部的 HTML，避免不同窗口里的同名属性互相干扰。 */
function dialogMarkup(id) {
  const match = new RegExp(
    `<dialog id="${id}"[\\s\\S]*?</dialog>`,
  ).exec(html);

  assert.ok(match, `index.html 中找不到 #${id}`);

  return match[0];
}

/** 取出某个容器里带 data-channel 的按钮顺序与文字。 */
function channelButtons(markup) {
  return Array.from(
    markup.matchAll(/data-channel="([^"]+)"[^>]*>\s*([^<\s][^<]*?)\s*</g),
  ).map((match) => ({ id: match[1], label: match[2] }));
}

const colorKeys = extractStringArray(app, "COLOR_CONTROL_KEYS");
const filterKeys = extractStringArray(app, "FILTER_CONTROL_KEYS");
const wbSliderKeys = extractStringArray(app, "WB_SLIDER_KEYS");
const wbSelectKeys = extractStringArray(app, "WB_SELECT_KEYS");
const posterizeSliderKeys = extractStringArray(app, "POSTERIZE_SLIDER_KEYS");
const sliderKeys = [...colorKeys, ...filterKeys, ...wbSliderKeys, ...posterizeSliderKeys];
const ids = htmlIds();

/* ---------------------------- 基础接线 ---------------------------- */

test("app.js 中静态引用的 #id 都存在于 index.html", () => {
  const referenced = Array.from(
    app.matchAll(/querySelector\(\s*["'`]#([A-Za-z0-9_-]+)["'`]\s*\)/g),
  ).map((match) => match[1]);

  assert.ok(referenced.length > 20, `只找到 ${referenced.length} 个 id 引用，解析可能失效`);

  for (const id of referenced) {
    assert.ok(ids.has(id), `index.html 缺少 #${id}`);
  }
});

test("每个滑条都有滑条本体、数字输入框与 data-key", () => {
  for (const key of sliderKeys) {
    assert.ok(ids.has(key), `缺少滑条 #${key}`);
    assert.ok(ids.has(`${key}Number`), `缺少数字输入框 #${key}Number`);
    assert.ok(
      html.includes(`class="number-input"`) &&
        new RegExp(`id="${key}Number"\\s+class="number-input"`).test(html),
      `#${key}Number 应该使用 number-input 样式`,
    );
    assert.ok(
      html.includes(`data-key="${key}"`),
      `缺少 data-key="${key}"（双击复位依赖它）`,
    );
  }
});

test("数字输入框在 app.js 中统一接线", () => {
  for (const token of [
    "const parsed = sliderValueFromField(key, number.value)",
    "function syncNumberField(key)",
    "function commitNumberField(key)",
    "function configureNumberField(key)",
    'number.addEventListener("input", () => applyNumberField(key))',
    'number.addEventListener("change", () => commitNumberField(key))',
  ]) {
    assert.ok(app.includes(token), `app.js 缺少 "${token}"`);
  }

  assert.ok(
    app.includes("#beautifyStrengthNumber") && ids.has("beautifyStrengthNumber"),
    "磨皮滑条也需要数字输入框",
  );
});

test("分组顺序与标题符合约定的排列", () => {
  const groupBlocks = Array.from(
    html.matchAll(/<section class="control-group">([\s\S]*?)<\/section>/g),
  ).map((match) => match[1]);
  const titles = groupBlocks.map(
    (block) => /<h3 class="control-group-title">([^<]+)<\/h3>/.exec(block)[1],
  );

  assert.deepEqual(titles, ["基础", "白平衡", "影调与风格", "降噪与细节"]);

  const expected = {
    基础: ["exposure", "brightness", "saturation", "vibrance", "contrast"],
    白平衡: [
      "whiteBalanceMode",
      "temperature",
      "whiteBalance",
      "wbKelvin",
      "wbTint",
      "wbPreset",
      "wbAlgorithm",
      "wbStrength",
      "wbGainR",
      "wbGainG",
      "wbGainB",
    ],
    影调与风格: ["shadows", "highlights", "hueShift"],
    降噪与细节: ["denoise", "detail"],
  };

  groupBlocks.forEach((block, index) => {
    const title = titles[index];
    const keys = Array.from(block.matchAll(/data-key="([^"]+)"/g)).map(
      (match) => match[1],
    );

    assert.deepEqual(keys, expected[title], `「${title}」分组的行顺序`);
  });

  // 色调分离与曲线排在色相偏移之后
  const toneGroup = groupBlocks[2];

  assert.ok(
    toneGroup.indexOf("色调分离") < toneGroup.indexOf("曲线"),
    "色调分离应排在曲线之前",
  );
  assert.ok(
    toneGroup.indexOf('id="hueShift"') < toneGroup.indexOf("色调分离"),
    "色相偏移应排在色调分离之前",
  );

  // AI 面板在最后
  assert.ok(
    html.indexOf('id="aiPanel"') > html.indexOf('id="detail"'),
    "AI 面板应排在所有调整参数之后",
  );
  assert.ok(html.includes("AI 人像美化"), "AI 分组标题");
});

test("色调分离与曲线都有开启勾选框", () => {
  for (const id of ["posterizeEnabled", "curvesEnabled"]) {
    assert.ok(ids.has(id), `缺少 #${id}`);
    assert.ok(app.includes(`#${id}`), `app.js 没有引用 #${id}`);
  }

  assert.match(
    html,
    /id="posterizeEnabled" type="checkbox"/,
    "色调分离的开启框应是 checkbox",
  );
  assert.match(
    html,
    /id="curvesEnabled" type="checkbox"/,
    "曲线的开启框应是 checkbox",
  );

  for (const token of [
    "function syncEffectSwitches()",
    "curvesEnabledInput.checked = curvesEnabled;",
    "posterizeEnabled.checked = Boolean(posterizeState.enabled);",
    "posterizeState.enabled = posterizeEnabled.checked;",
    "curvesEnabled = curvesEnabledInput.checked;",
    "curvesEnabled && !CURVES.isIdentityLut(composite)",
  ]) {
    assert.ok(app.includes(token), `app.js 缺少 "${token}"`);
  }

  assert.ok(
    styles.includes(".control-switch-box"),
    "styles.css 缺少勾选框样式",
  );
});

test("参数面板可以拖动缩放", () => {
  for (const id of ["panelSplitter"]) {
    assert.ok(ids.has(id), `缺少 #${id}`);
    assert.ok(app.includes(`#${id}`), `app.js 没有引用 #${id}`);
  }

  for (const token of [
    "function updateControlsHeight()",
    "function setControlsHeight(value, persist = true)",
    "panelSplitter.addEventListener(\"pointerdown\", beginSplitterDrag)",
    "panelSplitter.addEventListener(\"dblclick\", () => setControlsHeight(null))",
    'appShell.style.setProperty("--controls-height"',
  ]) {
    assert.ok(app.includes(token), `app.js 缺少 "${token}"`);
  }

  assert.ok(
    styles.includes(".panel-splitter") && styles.includes("row-resize"),
    "styles.css 缺少分隔条样式",
  );
  assert.ok(
    styles.includes("var(--controls-height"),
    "styles.css 布局没有使用 --controls-height",
  );
});

test("白平衡下拉菜单的 id 都已接线", () => {
  for (const key of wbSelectKeys) {
    assert.ok(ids.has(key), `缺少下拉菜单 #${key}`);
  }

  for (const id of ["whiteBalanceModeValue", "wbPresetValue", "wbAlgorithmValue", "wbGrayPointValue"]) {
    assert.ok(ids.has(id), `缺少输出 #${id}`);
  }
});

test("label 的 for 与 output 的 for 都指向存在的控件", () => {
  for (const target of [...attributes("for")]) {
    assert.ok(ids.has(target), `for="${target}" 指向不存在的元素`);
  }
});

/* ------------------------ 与色彩模块的一致性 ------------------------ */

test("白平衡方式下拉菜单与 WB_MODES 完全一致", () => {
  const options = selectOptions("whiteBalanceMode");

  assert.deepEqual(
    options.map((option) => option.value),
    wb.WB_MODES.map((mode) => mode.id),
  );
  assert.deepEqual(
    options.map((option) => option.label),
    wb.WB_MODES.map((mode) => mode.label),
  );
});

test("场景预设下拉菜单与 WB_PRESETS 完全一致", () => {
  const options = selectOptions("wbPreset");

  assert.deepEqual(
    options.map((option) => option.value),
    wb.WB_PRESETS.map((preset) => preset.id),
  );
  assert.deepEqual(
    options.map((option) => option.label),
    wb.WB_PRESETS.map((preset) => preset.label),
  );
});

test("自动算法下拉菜单与 AUTO_ALGORITHMS 完全一致", () => {
  const options = selectOptions("wbAlgorithm");

  assert.deepEqual(
    options.map((option) => option.value),
    wb.AUTO_ALGORITHMS.map((algorithm) => algorithm.id),
  );
  assert.deepEqual(
    options.map((option) => option.label),
    wb.AUTO_ALGORITHMS.map((algorithm) => algorithm.label),
  );
});

test("下拉菜单的默认选项与默认状态一致", () => {
  const defaults = wb.defaultWhiteBalanceState();

  assert.equal(selectOptions("whiteBalanceMode")[0].value, wb.WB_MODES[0].id);
  assert.equal(
    wb.WB_MODES[0].id,
    defaults.mode,
    "第一个白平衡方式应当就是默认方式",
  );

  const presetMatch = /<option value="([^"]+)" selected>/.exec(html);

  assert.ok(presetMatch, "index.html 中没有带 selected 的预设选项");
  assert.equal(presetMatch[1], defaults.preset, "预设默认项与默认状态不一致");
});

test("每种白平衡方式显示的行正好是它声明的参数", () => {
  const rowsByMode = new Map();

  for (const match of html.matchAll(/data-key="([^"]+)"\s+data-wb-mode="([^"]+)"/g)) {
    for (const mode of match[2].split(/\s+/)) {
      rowsByMode.set(mode, [...(rowsByMode.get(mode) || []), match[1]]);
    }
  }

  for (const mode of wb.WB_MODES) {
    const declared = [...mode.controls].sort();
    const rendered = [...(rowsByMode.get(mode.id) || [])].sort();

    assert.deepEqual(
      rendered,
      declared,
      `白平衡方式「${mode.label}」在 index.html 中显示的行与 WB_MODES 声明不一致`,
    );
  }
});

test("data-wb-mode 只使用已知的白平衡方式", () => {
  const known = new Set(wb.WB_MODES.map((mode) => mode.id));

  for (const value of attributes("data-wb-mode")) {
    for (const mode of value.split(/\s+/)) {
      assert.ok(known.has(mode), `未知的白平衡方式 "${mode}"`);
    }
  }
});

test("白平衡方式声明的参数都真实存在于界面上", () => {
  const known = new Set([...sliderKeys, ...wbSelectKeys, "whiteBalanceMode"]);

  for (const mode of wb.WB_MODES) {
    for (const key of mode.controls) {
      assert.ok(known.has(key), `参数 ${key} 没有对应的界面元素`);
    }
  }
});

/* ---------------------------- 样式与脚本 ---------------------------- */

test("index.html 先加载 white-balance.js 再加载 app.js", () => {
  const scienceIndex = html.indexOf("white-balance.js");

  assert.ok(scienceIndex > 0, "index.html 没有引入 white-balance.js");
  assert.ok(
    scienceIndex < html.indexOf("app.js"),
    "white-balance.js 必须在 app.js 之前加载",
  );
});

test("index.html 先加载 curves.js 再加载 app.js", () => {
  const curveIndex = html.indexOf("curves.js");

  assert.ok(curveIndex > 0, "index.html 没有引入 curves.js");
  assert.ok(
    curveIndex < html.indexOf("app.js"),
    "curves.js 必须在 app.js 之前加载",
  );
});

test("index.html 先加载 posterize.js 再加载 app.js", () => {
  const posterizeIndex = html.indexOf("posterize.js");

  assert.ok(posterizeIndex > 0, "index.html 没有引入 posterize.js");
  assert.ok(
    posterizeIndex < html.indexOf("app.js"),
    "posterize.js 必须在 app.js 之前加载",
  );
});

test("曲线通道按钮与 curves.js 的通道定义完全一致", () => {
  const buttons = channelButtons(dialogMarkup("curveDialog"));

  assert.deepEqual(
    buttons.map((button) => button.id),
    curves.CHANNELS.map((channel) => channel.id),
  );
  assert.deepEqual(
    buttons.map((button) => button.label),
    curves.CHANNELS.map((channel) => channel.label),
  );
});

test("色调分离窗口与 posterize.js 的定义完全一致", () => {
  const markup = dialogMarkup("posterizeDialog");
  const buttons = channelButtons(markup);
  const modes = Array.from(
    markup.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g),
  ).map((match) => ({ id: match[1], label: match[2].trim() }));

  assert.deepEqual(
    buttons.map((button) => button.id),
    posterize.CHANNELS.map((channel) => channel.id),
  );
  assert.deepEqual(
    buttons.map((button) => button.label),
    posterize.CHANNELS.map((channel) => channel.label),
  );
  assert.deepEqual(
    modes.map((mode) => mode.id),
    posterize.MODES.map((mode) => mode.id),
  );
  assert.deepEqual(
    modes.map((mode) => mode.label),
    posterize.MODES.map((mode) => mode.label),
  );
});

test("色调分离窗口的控件都已接线", () => {
  for (const id of [
    "posterizeButton",
    "posterizeDialog",
    "posterizePreview",
    "posterizeMode",
    "posterizeChannelRow",
    "posterizeChannelValue",
    "posterizeSummary",
    "resetPosterizeButton",
    "closePosterizeDialogButton",
  ]) {
    assert.ok(ids.has(id), `缺少 #${id}`);
    assert.ok(app.includes(`#${id}`), `app.js 没有引用 #${id}`);
  }

  // 两个滑条由 SLIDER_KEYS 通用机制接管，检查它们确实在列表里
  for (const key of posterizeSliderKeys) {
    assert.ok(
      app.includes(`"${key}"`),
      `app.js 的 POSTERIZE_SLIDER_KEYS 缺少 ${key}`,
    );
  }

  // 滑条的取值范围与默认值必须与 posterize.js 一致
  assert.match(
    html,
    new RegExp(
      `id="posterizeLevels"[^>]*min="${posterize.MIN_LEVELS}"[^>]*max="${posterize.MAX_LEVELS}"[^>]*value="${posterize.DEFAULT_LEVELS}"`,
    ),
    "级数滑条的范围与默认值应与 posterize.js 一致",
  );
  assert.match(
    html,
    new RegExp(
      `id="posterizeAmount"[^>]*min="0"[^>]*max="100"[^>]*value="${posterize.DEFAULT_AMOUNT}"`,
    ),
    "强度滑条的默认值应与 posterize.js 一致",
  );
});

test("曲线窗口的控件都已接线", () => {
  for (const id of [
    "curveButton",
    "curveDialog",
    "curveCanvas",
    "closeCurveDialogButton",
    "resetCurveButton",
    "curvePointValue",
  ]) {
    assert.ok(ids.has(id), `缺少 #${id}`);
    assert.ok(app.includes(`#${id}`), `app.js 没有引用 #${id}`);
  }

  for (const className of ["curve-channel", "curve-dialog"]) {
    assert.ok(html.includes(className), `index.html 缺少 .${className}`);
  }
});

test("新增样式类都在 styles.css 中有定义", () => {
  for (const className of [
    "select-wrap",
    "control-row-hint",
    "control-hint",
    "neutral-picker-mark",
    "is-picking",
    "curve-dialog",
    "curve-head",
    "curve-channels",
    "curve-channel",
    "curve-canvas",
    "curve-foot",
    "curve-point-value",
    "posterize-dialog",
    "posterize-preview",
    "posterize-field",
    "posterize-channel",
  ]) {
    assert.ok(
      styles.includes(`.${className}`),
      `styles.css 缺少 .${className}`,
    );
  }
});

test("着色器使用矩阵 uniform 应用白平衡", () => {
  for (const token of [
    "uniform mat3 u_wbMatrix;",
    "uniform float u_wbMatrixOn;",
    "uniform float u_wbLegacyOn;",
    "u_wbMatrix * srgbToLinear(color)",
  ]) {
    assert.ok(app.includes(token), `app.js 缺少 "${token}"`);
  }

  assert.ok(
    app.includes('getUniformLocation(program, "u_wbMatrix")'),
    "app.js 没有取得 u_wbMatrix 的位置",
  );
  assert.ok(
    app.includes("uniformMatrix3fv"),
    "app.js 没有上传 3x3 矩阵",
  );
});

test("着色器用两张 256 级查找表实现曲线", () => {
  for (const token of [
    "uniform sampler2D u_curveComposite;",
    "uniform sampler2D u_curveChannel;",
    "uniform float u_curvesOn;",
    "uniform float u_curveChannelsOn;",
    "vec3 applyCurves(vec3 color)",
    "color = applyCurves(color);",
  ]) {
    assert.ok(app.includes(token), `app.js 缺少 "${token}"`);
  }

  assert.ok(
    app.includes("texSubImage2D") && app.includes("createCurveLutTexture"),
    "app.js 没有上传曲线查找表纹理",
  );

  // GLSL ES 1.00 与 3.00 的纹理采样函数名不同，必须按版本切换
  assert.ok(
    app.includes('const sampler = webgl2 ? "texture" : "texture2D";'),
    "app.js 没有根据 GLSL 版本选择纹理采样函数",
  );

  assert.ok(
    app.includes('document.querySelector("#curveCanvas")'),
    "app.js 没有引用曲线画布",
  );
});

test("着色器用色块分级实现色调分离", () => {
  for (const token of [
    "uniform float u_posterizeLevels;",
    "uniform float u_posterizeAmount;",
    "uniform float u_posterizeMode;",
    "uniform vec3 u_posterizeChannels;",
    "float posterizeStep(float value, float levels)",
    "vec3 applyPosterize(vec3 color)",
    "color = applyPosterize(color);",
  ]) {
    assert.ok(app.includes(token), `app.js 缺少 "${token}"`);
  }

  // 分级公式必须与 posterize.js 的 quantize() 一致
  assert.ok(
    app.includes("floor(clamp(value, 0.0, 1.0) * (steps - 1.0) + 0.5) / (steps - 1.0)"),
    "着色器分级公式与 JS 端不一致",
  );
  assert.ok(
    app.includes("uniform3f(") && app.includes("u_posterizeChannels"),
    "app.js 没有上传通道开关",
  );
});

test("曲线查找表尺寸与 curves.js 的分级数一致", () => {
  assert.equal(curves.LEVELS, 256);
  assert.ok(
    app.includes("new Uint8Array(1024)"),
    "查找表缓冲应为 256 * 4 字节",
  );
});

test("浏览器冒烟测试脚本本身语法正确", () => {
  assert.ok(browserCheck.length > 0, "找不到 tools/browser-check.html");

  const inline = /<script>([\s\S]*?)<\/script>/.exec(browserCheck);

  assert.ok(inline, "browser-check.html 里找不到内联脚本");

  // 内联脚本是整段解析的：一处语法错误会让全部检查静默不执行
  assert.doesNotThrow(
    () => new Function(inline[1]),
    "browser-check.html 的内联脚本存在语法错误",
  );
});

test("浏览器冒烟测试会加载全部色彩模块", () => {
  for (const module of [
    "white-balance.js",
    "geometry.js",
    "curves.js",
    "posterize.js",
  ]) {
    assert.ok(
      browserCheck.includes(`loadScript("../${module}")`),
      `browser-check.html 没有加载 ${module}`,
    );
  }
});

/* ------------------------- 旋转与裁切（几何） ------------------------- */

test("index.html 先加载 geometry.js 再加载 app.js", () => {
  const geometryIndex = html.indexOf("geometry.js");

  assert.ok(geometryIndex > 0, "index.html 没有引入 geometry.js");
  assert.ok(
    geometryIndex < html.indexOf("app.js"),
    "geometry.js 必须在 app.js 之前加载",
  );
});

test("旋转裁切工具条的控件都已接线", () => {
  for (const id of [
    "geometryBar",
    "rotateLeftButton",
    "rotateRightButton",
    "flipHorizontalButton",
    "flipVerticalButton",
    "rotationAngle",
    "rotationAngleNumber",
    "resetGeometryButton",
    "cropButton",
    "cropAutoButton",
    "cropApplyButton",
    "cropCancelButton",
    "cropAspect",
    "geometryReadout",
    "cropControls",
  ]) {
    assert.ok(ids.has(id), `index.html 缺少 #${id}`);
    assert.ok(app.includes(`#${id}`), `app.js 没有引用 #${id}`);
  }

  // 工具条必须放在图片框（预览区）里，而不是参数面板里
  const previewBlock = /<main id="previewStage"[\s\S]*?<\/main>/.exec(html);

  assert.ok(previewBlock, "找不到 #previewStage");
  assert.ok(
    previewBlock[0].includes('id="geometryBar"'),
    "旋转裁切工具条应当直接放在图片框里",
  );
});

test("裁切框的手柄与遮罩齐全", () => {
  for (const edge of geometry.CROP_EDGES) {
    assert.ok(
      html.includes(`data-handle="${edge}"`),
      `index.html 缺少裁切手柄 ${edge}`,
    );
  }

  assert.ok(
    /id="cropBox"[^>]*data-handle="move"/.test(html),
    "裁切框自身应当可以整体拖动",
  );

  for (const side of ["top", "right", "bottom", "left"]) {
    assert.ok(
      html.includes(`data-side="${side}"`),
      `index.html 缺少裁切遮罩 ${side}`,
    );
  }
});

test("裁切比例下拉菜单与 geometry.js 的比例定义完全一致", () => {
  const options = selectOptions("cropAspect");

  assert.deepEqual(
    options.map((option) => option.value),
    geometry.ASPECTS.map((aspect) => aspect.id),
  );
  assert.deepEqual(
    options.map((option) => option.label),
    geometry.ASPECTS.map((aspect) => aspect.label),
  );
});

test("着色器用视图矩阵实现旋转裁切", () => {
  for (const token of [
    "uniform vec2 u_outputSize;",
    "uniform mat3 u_viewMatrix;",
    "vec2 sourcePoint()",
    "bool insideSource(vec2 point)",
    "GEO.viewMatrix(renderer.textureWidth, renderer.textureHeight, geometry)",
    "gl.uniform2f(uniforms.outputSize, width, height)",
    "function identityViewMatrix(textureWidth, textureHeight)",
    "function drawGeometryView(",
  ]) {
    assert.ok(app.includes(token), `app.js 缺少 "${token}"`);
  }

  // 画面外的采样点必须输出透明，而不是拉伸边缘像素
  assert.ok(
    app.includes("if (!insideSource(point))"),
    "着色器没有处理旋转后的空白角",
  );

  // GLSL ES 1.00 没有整数 clamp 重载，回退着色器必须转成浮点再取整
  assert.ok(
    app.includes("int(clamp(floor(source.x), 0.0, u_textureSize.x - 1.0))"),
    "WebGL1 回退着色器缺少浮点 clamp 写法",
  );
});

test("旋转裁切的样式都已定义", () => {
  for (const className of [
    "geometry-bar",
    "geometry-group",
    "geometry-angle",
    "geometry-crop-controls",
    "geometry-aspect",
    "geometry-readout",
    "crop-overlay",
    "crop-shade",
    "crop-box",
    "crop-grid",
    "crop-handle",
    "is-cropping",
  ]) {
    assert.ok(
      styles.includes(`.${className}`),
      `styles.css 缺少 .${className}`,
    );
  }

  assert.ok(
    styles.includes("grid-template-rows: minmax(0, 1fr) auto"),
    "预览区需要单独一行放工具条",
  );
});

test("旋转与裁切的默认状态不会改动画面", () => {
  const defaults = geometry.createState();

  assert.equal(geometry.isIdentity(defaults), true);
  assert.equal(geometry.describe(defaults, 1600, 900), "未调整");
  assert.ok(
    app.includes("function getRenderGeometry()"),
    "app.js 缺少渲染几何入口",
  );
  assert.ok(
    app.includes("cropMode") &&
      app.includes("{ ...geometryState, crop: { ...GEO.FULL_CROP } }"),
    "裁切模式下应当显示整幅旋转画面",
  );
});

/* ---------------------------- 版本一致性 ---------------------------- */

test("VERSION、index.html 缓存参数、CHANGELOG 与 README 版本一致", () => {
  const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const desktopPackage = JSON.parse(
    fs.readFileSync(path.join(root, "desktop", "package.json"), "utf8"),
  );

  assert.match(version, /^\d+\.\d+\.\d+$/, `VERSION 内容不是语义化版本："${version}"`);

  // index.html 里每个脚本的缓存参数都必须等于当前版本，否则升级后浏览器会用旧文件
  const scriptVersions = Array.from(
    html.matchAll(/<script src="[^"]+\?v=([^"]+)"/g),
  ).map((match) => match[1]);

  assert.equal(scriptVersions.length, 5, "index.html 的脚本数量与预期不符");

  for (const scriptVersion of scriptVersions) {
    assert.equal(scriptVersion, version, "index.html 的 ?v= 参数与 VERSION 不一致");
  }

  const latest = /^## \[([^\]]+)\]/m.exec(changelog);

  assert.ok(latest, "CHANGELOG.md 找不到版本条目");
  assert.equal(latest[1], version, "CHANGELOG.md 最新条目与 VERSION 不一致");
  assert.match(
    readme,
    new RegExp(`当前版本 \\*\\*v${version.replace(/\./g, "\\.")}\\*\\*`),
    "README.md 的版本行与 VERSION 不一致",
  );
  assert.equal(
    desktopPackage.version,
    version,
    "desktop/package.json 的版本与 VERSION 不一致",
  );
});

/* ------------------------------ 结果汇总 ------------------------------ */

if (failures.length > 0) {
  console.error(`\n界面一致性测试：${passed} 通过，${failures.length} 失败\n`);

  for (const failure of failures) {
    console.error(`  ✗ ${failure.name}\n    ${failure.message}`);
  }

  process.exitCode = 1;
} else {
  console.log(`界面一致性测试：${passed} 项全部通过`);
}
