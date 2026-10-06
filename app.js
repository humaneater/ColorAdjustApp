(() => {
  "use strict";

  const COLOR_CONTROL_KEYS = [
    "saturation",
    "hueShift",
    "vibrance",
    "brightness",
    "exposure",
    "contrast",
    "temperature",
    "whiteBalance",
    "shadows",
    "highlights",
  ];
  const FILTER_CONTROL_KEYS = ["denoise", "detail"];
  const CONTROL_KEYS = [...COLOR_CONTROL_KEYS, ...FILTER_CONTROL_KEYS];

  /**
   * 白平衡色彩科学模块（white-balance.js）。
   * 所有「白平衡方式」最终都会被换算成同一个 3x3 色适应矩阵。
   */
  const WB = globalThis.ColorWhiteBalance || null;
  /** 曲线模型（curves.js）：贝塞尔控制点 → 256 级查找表。 */
  const CURVES = globalThis.ColorCurves || null;
  /** 色调分离模型（posterize.js）。 */
  const POSTERIZE = globalThis.ColorPosterize || null;
  /**
   * 旋转与裁切几何（geometry.js）。
   * 旋转 / 翻转 / 裁切最终都换算成一个 3x3 视图矩阵，
   * 预览、原图对比、导出、AI 结果共用同一套映射。
   */
  const GEO = globalThis.ColorGeometry || null;
  /** 白平衡方式自己的滑条：不直接对应着色器 uniform，由矩阵统一表达。 */
  const WB_SLIDER_KEYS = [
    "wbKelvin",
    "wbTint",
    "wbStrength",
    "wbGainR",
    "wbGainG",
    "wbGainB",
  ];
  const WB_SELECT_KEYS = ["whiteBalanceMode", "wbPreset", "wbAlgorithm"];
  /** 色调分离的两个滑条（位于弹出的色调分离窗口里）。 */
  const POSTERIZE_SLIDER_KEYS = ["posterizeLevels", "posterizeAmount"];
  const SLIDER_KEYS = [...CONTROL_KEYS, ...WB_SLIDER_KEYS, ...POSTERIZE_SLIDER_KEYS];
  const BIPOLAR_KEYS = new Set([
    ...COLOR_CONTROL_KEYS,
    "wbTint",
    "wbGainR",
    "wbGainG",
    "wbGainB",
  ]);
  /** 双击滑条时恢复的数值（显示单位），未列出的键恢复为 0。 */
  const CONTROL_RESET_VALUES = Object.freeze({
    wbKelvin: 6500,
    wbStrength: 100,
    posterizeLevels: 8,
    posterizeAmount: 0,
  });
  const DEFAULT_SETTINGS = Object.freeze({
    saturation: 0,
    hueShift: 0,
    vibrance: 0,
    brightness: 0,
    exposure: 0,
    contrast: 0,
    temperature: 0,
    whiteBalance: 0,
    shadows: 0,
    highlights: 0,
    denoise: 0,
    detail: 0,
  });

  const PREVIEW_MAX_EDGE = 2400;
  const JPEG_QUALITY = 0.95;
  const RAW_DECODE_TIMEOUT = 180000;
  const AI_POLL_INTERVAL = 900;
  const AI_ERROR_MESSAGES = new Map([
    ["ComfyUI stopped while the task was running.", "ComfyUI 在处理过程中停止运行，请重试"],
    ["ComfyUI reported an execution error.", "ComfyUI 执行出错，可能是显存不足或节点异常"],
    ["ComfyUI completed without an output image.", "ComfyUI 没有返回结果图"],
    ["ComfyUI is not configured.", "尚未配置 ComfyUI，请先点击“设置”"],
    ["ComfyUI path is invalid.", "ComfyUI 路径无效，请在设置中重新检测"],
    ["ComfyUI exited during startup.", "ComfyUI 启动过程中退出"],
    ["ComfyUI did not become ready within 90 seconds.", "ComfyUI 90 秒内没有就绪"],
    ["Portrait workflow template is missing.", "缺少人像工作流模板 comfy/PortraitApi.json"],
    ["No SAM model was found in ComfyUI models\\sams.", "未在 ComfyUI 的 models\\sams 中找到 SAM 模型"],
    ["face_yolov8m.pt was not found in ComfyUI models.", "未在 ComfyUI 的 models 中找到 face_yolov8m.pt"],
    ["The selected checkpoint is not available.", "所选模型不可用，请刷新模型列表"],
    ["ComfyUI did not return an uploaded image name.", "ComfyUI 没有返回上传后的图片名"],
    ["ComfyUI did not accept the workflow.", "ComfyUI 拒绝了工作流"],
    ["The uploaded image is empty.", "上传的图片为空"],
    ["No portrait checkpoint was selected.", "没有选择人像模型"],
    ["The task result is not ready.", "任务结果还没有准备好"],
    ["The task result file is missing.", "任务结果文件缺失"],
    ["The AI result file is missing.", "AI 结果文件缺失"],
    ["Task not found.", "任务不存在"],
    ["ComfyUI port must be between 1 and 65535.", "端口必须在 1 到 65535 之间"],
    [
      "The folder does not contain ComfyUI\\main.py and python_embeded\\python.exe.",
      "该目录中缺少 ComfyUI\\main.py 或 python_embeded\\python.exe",
    ],
  ]);
  const RAW_EXTENSIONS = new Set([
    "3fr",
    "arw",
    "bay",
    "cap",
    "cr2",
    "cr3",
    "crw",
    "cs1",
    "dc2",
    "dcr",
    "dcs",
    "dng",
    "drf",
    "eip",
    "erf",
    "fff",
    "fjs",
    "gpr",
    "iiq",
    "kdc",
    "mdc",
    "mef",
    "mos",
    "mrw",
    "nef",
    "nrw",
    "orf",
    "pef",
    "pxn",
    "qtk",
    "raf",
    "raw",
    "rw2",
    "rwl",
    "rwz",
    "sr2",
    "srf",
    "srw",
    "sti",
    "x3f",
  ]);
  const LIBRAW_MODULE_URL = new URL(
    "./vendor/libraw-wasm/index.js",
    document.baseURI,
  ).href;
  const RAW_DECODE_SETTINGS = Object.freeze({
    useCameraWb: true,
    useCameraMatrix: 3,
    outputColor: 1,
    outputBps: 16,
    userQual: 3,
  });

  const previewStage = document.querySelector("#previewStage");
  const dropLayer = document.querySelector("#dropLayer");
  const fileInput = document.querySelector("#fileInput");
  const fileName = document.querySelector("#fileName");
  const resetButton = document.querySelector("#resetButton");
  const exportButton = document.querySelector("#exportButton");
  const controlsFieldset = document.querySelector("#controlsFieldset");
  const originalCanvas = document.querySelector("#originalCanvas");
  const processedCanvas = document.querySelector("#processedCanvas");
  const aiCanvas = document.querySelector("#aiCanvas");
  const processedLabel = document.querySelector("#processedLabel");
  const processedPanel = document.querySelector("#processedPanel");
  const toast = document.querySelector("#toast");
  const whiteBalanceModeSelect = document.querySelector("#whiteBalanceMode");
  const whiteBalanceModeRow = document.querySelector('[data-key="whiteBalanceMode"]');
  const whiteBalanceModeValue = document.querySelector("#whiteBalanceModeValue");
  const wbPresetSelect = document.querySelector("#wbPreset");
  const wbPresetValue = document.querySelector("#wbPresetValue");
  const wbAlgorithmSelect = document.querySelector("#wbAlgorithm");
  const wbAlgorithmValue = document.querySelector("#wbAlgorithmValue");
  const wbGrayPointValue = document.querySelector("#wbGrayPointValue");
  const wbGrayPointHint = document.querySelector("#wbGrayPointHint");
  const wbModeRows = Array.from(document.querySelectorAll("[data-wb-mode]"));
  const previewPanels = Array.from(document.querySelectorAll(".preview-panel"));
  const curveButton = document.querySelector("#curveButton");
  const curveDialog = document.querySelector("#curveDialog");
  const closeCurveDialogButton = document.querySelector("#closeCurveDialogButton");
  const resetCurveButton = document.querySelector("#resetCurveButton");
  const curveCanvas = document.querySelector("#curveCanvas");
  const curvePointValue = document.querySelector("#curvePointValue");
  const curveChannelButtons = Array.from(
    document.querySelectorAll(".curve-channel"),
  );
  const posterizeButton = document.querySelector("#posterizeButton");
  const posterizeDialog = document.querySelector("#posterizeDialog");
  const closePosterizeDialogButton = document.querySelector(
    "#closePosterizeDialogButton",
  );
  const resetPosterizeButton = document.querySelector("#resetPosterizeButton");
  const posterizePreview = document.querySelector("#posterizePreview");
  const posterizeModeSelect = document.querySelector("#posterizeMode");
  const posterizeChannelRow = document.querySelector("#posterizeChannelRow");
  const posterizeChannelButtons = Array.from(
    document.querySelectorAll(".posterize-channel"),
  );
  const posterizeSummary = document.querySelector("#posterizeSummary");
  const posterizeChannelValue = document.querySelector("#posterizeChannelValue");
  const posterizeRowValue = document.querySelector("#posterizeRowValue");
  const posterizeEnabled = document.querySelector("#posterizeEnabled");
  const curveRowValue = document.querySelector("#curveRowValue");
  const curvesEnabledInput = document.querySelector("#curvesEnabled");
  const geometryBar = document.querySelector("#geometryBar");
  const rotateLeftButton = document.querySelector("#rotateLeftButton");
  const rotateRightButton = document.querySelector("#rotateRightButton");
  const flipHorizontalButton = document.querySelector("#flipHorizontalButton");
  const flipVerticalButton = document.querySelector("#flipVerticalButton");
  const rotationAngle = document.querySelector("#rotationAngle");
  const rotationAngleNumber = document.querySelector("#rotationAngleNumber");
  const resetGeometryButton = document.querySelector("#resetGeometryButton");
  const cropButton = document.querySelector("#cropButton");
  const cropAspectSelect = document.querySelector("#cropAspect");
  const cropAutoButton = document.querySelector("#cropAutoButton");
  const cropApplyButton = document.querySelector("#cropApplyButton");
  const cropCancelButton = document.querySelector("#cropCancelButton");
  const geometryReadout = document.querySelector("#geometryReadout");
  const cropControls = document.querySelector("#cropControls");
  const cropOverlay = document.querySelector("#cropOverlay");
  const cropShades = Array.from(document.querySelectorAll(".crop-shade"));
  const cropBox = document.querySelector("#cropBox");
  const panelSplitter = document.querySelector("#panelSplitter");
  const appShell = document.querySelector(".app-shell");
  const modelSelect = document.querySelector("#modelSelect");
  const refreshModelsButton = document.querySelector("#refreshModelsButton");
  const beautifyStrength = document.querySelector("#beautifyStrength");
  const beautifyStrengthNumber = document.querySelector("#beautifyStrengthNumber");
  const beautifyButton = document.querySelector("#beautifyButton");
  const openAiResultButton = document.querySelector("#openAiResultButton");
  const revealAiResultButton = document.querySelector("#revealAiResultButton");
  const aiStatus = document.querySelector("#aiStatus");
  const comfySettingsButton = document.querySelector("#comfySettingsButton");
  const comfyDialog = document.querySelector("#comfyDialog");
  const comfyForm = document.querySelector("#comfyForm");
  const comfyRootInput = document.querySelector("#comfyRootInput");
  const comfyPortInput = document.querySelector("#comfyPortInput");
  const comfyConfigMessage = document.querySelector("#comfyConfigMessage");
  const saveComfyConfigButton = document.querySelector(
    "#saveComfyConfigButton",
  );
  const closeComfyDialogButton = document.querySelector(
    "#closeComfyDialogButton",
  );
  const cancelComfyDialogButton = document.querySelector(
    "#cancelComfyDialogButton",
  );

  const controls = new Map(
    SLIDER_KEYS.map((key) => [
      key,
      {
        input: document.querySelector(`#${key}`),
        output: document.querySelector(`#${key}Value`),
        number: document.querySelector(`#${key}Number`),
        row: document.querySelector(`[data-key="${key}"]`),
      },
    ]),
  );

  let currentSource = null;
  let sourceFile = null;
  let sourceUrl = "";
  let previewTextureSource = null;
  let previewDisplayCanvas = null;
  let previewRenderer = null;
  let previewSize = { width: 0, height: 0 };
  /** 整幅画面（未旋转裁切前）的显示尺寸，也是预览纹理的尺寸。 */
  let frameSize = { width: 0, height: 0 };
  let geometryState = createDefaultGeometry();
  let cropMode = false;
  let cropBackup = null;
  let cropAspect = "free";
  let cropDrag = null;
  let settings = createDefaultSettings();
  let whiteBalance = createDefaultWhiteBalance();
  let whiteBalanceResult = null;
  let whiteBalanceCacheKey = "";
  let analysisCache = { revision: -1, buffer: null };
  let grayPointMarker = null;
  let curvesState = createDefaultCurves();
  let curvesEnabled = true;
  let curveLutRevision = 0;
  let curveCompositeLut = new Uint8Array(1024);
  let curveChannelLut = new Uint8Array(1024);
  let curveUniforms = { compositeOn: 0, channelsOn: 0 };
  let curveSelection = -1;
  let curveDrag = null;
  let curveHistogram = null;
  let curveHistogramAt = 0;
  let curveView = { size: 300, dpr: 1 };
  let posterizeState = createDefaultPosterize();
  let posterizeUniforms = { enabled: false, levels: 8, amount: 0, mode: 0, channels: [1, 1, 1] };
  let posterizeView = { width: 304, height: 48, dpr: 1 };
  let frameRequest = 0;
  let exportInProgress = false;
  let imageLoadInProgress = false;
  let loadRequestId = 0;
  let libRawModulePromise = null;
  let activeRawDecoder = null;
  let dragDepth = 0;
  let toastTimer = 0;
  let sourceRevision = 0;
  let renderRevision = 0;
  let comfyStatus = {
    available: false,
    valid: false,
    online: false,
    root: "",
    port: 8188,
    models: [],
    error: "",
  };
  let aiJob = null;
  let aiJobToken = 0;
  let activeAiResult = null;
  let lastAiOutput = null;
  let comfyStatusRequest = 0;
  let webgl2Supported = null;

  function createDefaultSettings() {
    return { ...DEFAULT_SETTINGS };
  }

  function createDefaultWhiteBalance() {
    if (WB) {
      return WB.defaultWhiteBalanceState();
    }

    // white-balance.js 没载入时退回旧版手动双轴，保证原有功能可用
    return {
      mode: "manual",
      kelvin: 6500,
      tint: 0,
      preset: "daylight",
      algorithm: "grayWorld",
      strength: 100,
      catSpace: "bradford",
      gains: { r: 0, g: 0, b: 0 },
      sample: null,
    };
  }

  function channelGainFactor(value) {
    return WB ? WB.gainSliderToFactor(value) : 1;
  }

  function createDefaultCurves() {
    return CURVES ? CURVES.createCurveState() : null;
  }

  function createDefaultPosterize() {
    if (POSTERIZE) {
      return POSTERIZE.createState();
    }

    return {
      levels: 8,
      amount: 0,
      mode: "luma",
      channels: { r: true, g: true, b: true },
    };  }

  /** 旋转与裁切的默认状态：不转、不翻、铺满整幅画面。 */
  function createDefaultGeometry() {
    if (GEO) {
      return GEO.createState();
    }

    // geometry.js 没载入时退化成恒等几何，界面上的按钮会被禁用
    return {
      quarter: 0,
      angle: 0,
      flipH: false,
      flipV: false,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    };
  }

  /* ------------------------------------------------------------------ *
   * 旋转与裁切：几何状态 → 视图矩阵 → 画布
   * ------------------------------------------------------------------ */

  /**
   * 实际用于渲染的几何。
   * 裁切模式下先把整幅旋转画面显示出来，裁切框只作为覆盖层，
   * 这样用户才能把框往外拖；点「应用」后才真的按裁切框显示。
   */
  function getRenderGeometry() {
    if (!GEO || !currentSource) {
      return null;
    }

    return cropMode
      ? { ...geometryState, crop: { ...GEO.FULL_CROP } }
      : geometryState;
  }

  /** 画面几何是否真的改变了画面（用于显示状态与快捷键）。 */
  function hasGeometry() {
    return Boolean(GEO) && !GEO.isIdentity(geometryState);
  }

  function computeViewSize(textureWidth, textureHeight, geometry) {
    if (!GEO || !geometry) {
      return { width: textureWidth, height: textureHeight };
    }

    return GEO.viewSize(textureWidth, textureHeight, geometry);
  }

  /**
   * 恒等视图矩阵：把归一化输出坐标映射到纹理坐标。
   * 注意它不是单位矩阵——分量单位是纹素，所以对角线上是纹理宽高。
   */
  const identityMatrixScratch = new Float32Array(9);

  function identityViewMatrix(textureWidth, textureHeight) {
    identityMatrixScratch[0] = textureWidth;
    identityMatrixScratch[4] = textureHeight;
    identityMatrixScratch[8] = 1;

    return identityMatrixScratch;
  }

  /**
   * 把整幅画面按当前几何画进输出画布（原图对比、AI 结果都用它）。
   * 变换参数由 geometry.js 求出，和着色器里的矩阵完全一致。
   */
  function drawGeometryView(
    context,
    source,
    textureWidth,
    textureHeight,
    geometry,
    view,
    matte,
  ) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, view.width, view.height);

    if (matte) {
      context.fillStyle = matte;
      context.fillRect(0, 0, view.width, view.height);
    }

    if (!source || !textureWidth || !textureHeight) {
      return;
    }

    const transform = GEO
      ? GEO.viewTransform(
          textureWidth,
          textureHeight,
          geometry,
          view.width,
          view.height,
        )
      : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.setTransform(
      transform.a,
      transform.b,
      transform.c,
      transform.d,
      transform.e,
      transform.f,
    );
    // 画面以外的地方保持透明，让画布底纹透出来
    context.beginPath();
    context.rect(0, 0, textureWidth, textureHeight);
    context.clip();
    context.drawImage(source, 0, 0, textureWidth, textureHeight);
    context.restore();
  }

  /** 几何变化后刷新预览、按钮状态与读数。 */
  function applyGeometryChange() {
    syncGeometryControls();
    updateGeometryReadout();
    positionCropOverlay();
    schedulePreviewRender();
  }

  function setCropMode(enabled) {
    if (enabled === cropMode) {
      return;
    }

    if (enabled) {
      cropBackup = { ...geometryState, crop: { ...geometryState.crop } };
      cropMode = true;
    } else {
      cropMode = false;
      cropDrag = null;
    }

    updateCropControls();
    applyGeometryChange();
  }

  function applyCropEdit() {
    if (!GEO || !cropMode) {
      return;
    }

    geometryState = { ...geometryState, crop: { ...geometryState.crop } };
    cropMode = false;
    cropBackup = null;
    cropDrag = null;
    updateCropControls();
    applyGeometryChange();
  }

  function cancelCropEdit() {
    if (!GEO) {
      return;
    }

    if (cropBackup) {
      geometryState = { ...cropBackup, crop: { ...cropBackup.crop } };
      cropBackup = null;
    }

    cropMode = false;
    cropDrag = null;
    updateCropControls();
    applyGeometryChange();
  }

  /** 旋转后画面的外接矩形（裁切框的像素坐标系）。 */
  function cropBounds() {
    if (!GEO || !frameSize.width || !frameSize.height) {
      return { width: 1, height: 1 };
    }

    return GEO.rotatedBounds(
      frameSize.width,
      frameSize.height,
      GEO.totalAngle(geometryState),
    );
  }

  /** 当前锁定的像素宽高比（自由时返回 null）。 */
  function cropRatio() {
    if (!GEO) {
      return null;
    }

    const bounds = cropBounds();

    return GEO.aspectRatio(cropAspect, bounds.width / bounds.height);
  }

  /** 归一化空间里的宽高比，供拖动裁切框使用。 */
  function normalizedCropRatio() {
    const ratio = cropRatio();
    const bounds = cropBounds();

    if (!ratio || !bounds.width || !bounds.height) {
      return null;
    }

    return ratio / (bounds.width / bounds.height);
  }

  function updateGeometryReadout() {
    if (cropControls) {
      cropControls.hidden = !cropMode;
    }

    if (!geometryReadout) {
      return;
    }

    if (!GEO) {
      geometryReadout.textContent = "不可用";

      return;
    }

    if (cropMode) {
      updateCropSizeReadout();

      return;
    }

    geometryReadout.textContent = GEO.describe(
      geometryState,
      frameSize.width,
      frameSize.height,
    );
    geometryReadout.classList.toggle(
      "is-active",
      Boolean(currentSource) && hasGeometry(),
    );
  }

  /** 裁切模式下把读数换成裁切框的像素尺寸（拖动时实时更新）。 */
  function updateCropSizeReadout() {
    if (!cropMode || !geometryReadout || !GEO) {
      return;
    }

    const rect = GEO.cropRect(cropBounds(), geometryState.crop);

    geometryReadout.textContent = `裁切 ${Math.round(rect.width)} × ${Math.round(
      rect.height,
    )}`;
    geometryReadout.classList.add("is-active");
  }

  function syncGeometryControls() {
    if (rotationAngle) {
      const value = GEO ? GEO.clamp(Number(geometryState.angle) || 0, -GEO.MAX_FINE_ANGLE, GEO.MAX_FINE_ANGLE) : 0;

      if (rotationAngle.value !== String(value)) {
        rotationAngle.value = String(value);
      }

      rotationAngle.style.setProperty("--fill-start", "0%");
      rotationAngle.style.setProperty("--fill-end", `${((value + 45) / 90) * 100}%`);
      rotationAngle.setAttribute(
        "aria-valuetext",
        value === 0
          ? "没有倾斜"
          : `旋转 ${GEO ? GEO.formatAngle(value) : value} 度`,
      );
    }

    if (rotationAngleNumber && document.activeElement !== rotationAngleNumber) {
      const value = Number(geometryState.angle) || 0;

      rotationAngleNumber.value = GEO ? GEO.formatAngle(value) : String(value);
    }

    if (geometryBar) {
      const ready = Boolean(currentSource && GEO);
      const wasHidden = geometryBar.hidden;

      geometryBar.hidden = !currentSource;

      for (const button of [
        rotateLeftButton,
        rotateRightButton,
        flipHorizontalButton,
        flipVerticalButton,
        resetGeometryButton,
        cropButton,
        cropAutoButton,
        cropApplyButton,
        cropCancelButton,
      ]) {
        if (button) {
          button.disabled = !ready;
        }
      }

      if (wasHidden !== geometryBar.hidden) {
        updateControlsHeight();
      }
    }
  }

  function updateCropControls() {
    if (cropButton) {
      cropButton.classList.toggle("is-active", cropMode);
      cropButton.setAttribute("aria-pressed", String(cropMode));
      cropButton.textContent = cropMode ? "退出裁切" : "裁切";
    }

    if (cropControls) {
      cropControls.hidden = !cropMode;
    }

    if (processedPanel) {
      processedPanel.classList.toggle("is-cropping", cropMode);
    }

    if (cropOverlay) {
      cropOverlay.hidden = !cropMode;
    }

    if (cropAspectSelect && cropAspectSelect.value !== cropAspect) {
      cropAspectSelect.value = cropAspect;
    }

    positionCropOverlay();
  }

  /** 裁切框在右侧画面上的位置（画面用 object-fit: contain 居中）。 */
  function cropOverlayMetrics() {
    if (!cropMode) {
      return null;
    }

    const metrics = canvasDisplayMetrics(processedCanvas);

    if (!metrics) {
      return null;
    }

    const panelRect = processedPanel.getBoundingClientRect();
    const { rect } = metrics;

    return {
      left: rect.left - panelRect.left + metrics.offsetX,
      top: rect.top - panelRect.top + metrics.offsetY,
      scale: metrics.scale,
      width: previewSize.width,
      height: previewSize.height,
    };
  }

  function positionCropOverlay() {
    if (!cropMode || !cropOverlay || !GEO) {
      return;
    }

    const metrics = cropOverlayMetrics();

    if (!metrics) {
      return;
    }

    const bounds = cropBounds();
    const rect = GEO.cropRect(bounds, geometryState.crop);
    const left = metrics.left + rect.x * metrics.scale;
    const top = metrics.top + rect.y * metrics.scale;
    const width = Math.max(8, rect.width * metrics.scale);
    const height = Math.max(8, rect.height * metrics.scale);
    const right = left + width;
    const bottom = top + height;
    const overlayWidth = metrics.left + metrics.width * metrics.scale;
    const overlayHeight = metrics.top + metrics.height * metrics.scale;

    if (cropBox) {
      cropBox.style.left = `${left}px`;
      cropBox.style.top = `${top}px`;
      cropBox.style.width = `${width}px`;
      cropBox.style.height = `${height}px`;
    }

    const frames = {
      top: [0, metrics.top, overlayWidth, Math.max(0, top - metrics.top)],
      bottom: [0, bottom, overlayWidth, Math.max(0, overlayHeight - bottom)],
      left: [0, top, Math.max(0, left), height],
      right: [right, top, Math.max(0, overlayWidth - right), height],
    };

    for (const shade of cropShades) {
      const frame = frames[shade.dataset.side];

      if (!frame) {
        continue;
      }

      shade.style.left = `${frame[0]}px`;
      shade.style.top = `${frame[1]}px`;
      shade.style.width = `${frame[2]}px`;
      shade.style.height = `${frame[3]}px`;
    }
  }

  /** 指针位置 → 画面归一化坐标（超出画面时返回 null）。 */
  function cropPointerPosition(event) {
    const metrics = cropOverlayMetrics();

    if (!metrics) {
      return null;
    }

    const panelRect = processedPanel.getBoundingClientRect();
    const x = event.clientX - panelRect.left - metrics.left;
    const y = event.clientY - panelRect.top - metrics.top;

    return { u: x / (metrics.width * metrics.scale), v: y / (metrics.height * metrics.scale) };
  }

  function beginCropDrag(event) {
    if (!cropMode || !GEO || event.button !== 0) {
      return;
    }

    const position = cropPointerPosition(event);

    if (!position) {
      return;
    }

    const handle = event.target.closest?.("[data-handle]")?.dataset.handle;
    const start = GEO.normalizeCrop(geometryState.crop);

    cropDrag = {
      pointerId: event.pointerId,
      handle: handle || "new",
      startU: position.u,
      startV: position.v,
      startCrop: start,
      bounds: cropBounds(),
    };

    // 在框外按下时，从这一点开始重新拉一个框
    if (!handle) {
      geometryState = {
        ...geometryState,
        crop: GEO.normalizeCrop({
          x: position.u,
          y: position.v,
          width: 0.001,
          height: 0.001,
        }),
      };
      cropDrag.handle = "new";
      positionCropOverlay();
    }

    try {
      cropOverlay.setPointerCapture(event.pointerId);
    } catch {
      // 指针已经消失时忽略
    }

    event.preventDefault();
  }

  function continueCropDrag(event) {
    if (!cropDrag || !GEO || event.pointerId !== cropDrag.pointerId) {
      return;
    }

    const position = cropPointerPosition(event);

    if (!position) {
      return;
    }

    const ratio = normalizedCropRatio();

    if (cropDrag.handle === "new") {
      const next = GEO.normalizeCrop({
        x: Math.min(cropDrag.startU, position.u),
        y: Math.min(cropDrag.startV, position.v),
        width: Math.abs(position.u - cropDrag.startU),
        height: Math.abs(position.v - cropDrag.startV),
      });

      geometryState = {
        ...geometryState,
        crop: ratio ? GEO.applyAspect(next, cropRatio(), cropDrag.bounds) : next,
      };
    } else {
      geometryState = {
        ...geometryState,
        crop: GEO.dragCrop(
          cropDrag.startCrop,
          cropDrag.handle,
          position.u - cropDrag.startU,
          position.v - cropDrag.startV,
          ratio,
        ),
      };
    }

    positionCropOverlay();
    updateCropSizeReadout();
  }

  function endCropDrag() {
    if (!cropDrag) {
      return;
    }

    try {
      if (cropOverlay.hasPointerCapture?.(cropDrag.pointerId)) {
        cropOverlay.releasePointerCapture(cropDrag.pointerId);
      }
    } catch {
      // 指针已经不存在时忽略
    }

    cropDrag = null;
    applyGeometryChange();
  }

  function nudgeCrop(stepX, stepY) {
    if (!GEO || !cropMode) {
      return;
    }

    geometryState = {
      ...geometryState,
      crop: GEO.dragCrop(geometryState.crop, "move", stepX, stepY, null),
    };
    applyGeometryChange();
  }

  function applyAutoCrop() {
    if (!GEO || !frameSize.width || !frameSize.height) {
      return;
    }

    geometryState = {
      ...geometryState,
      crop: GEO.inscribedCrop(
        frameSize.width,
        frameSize.height,
        { ...geometryState, crop: { ...GEO.FULL_CROP } },
      ),
    };

    if (cropAspect !== "free") {
      cropAspect = "free";
      cropAspectSelect.value = "free";
    }

    applyGeometryChange();
  }

  function rotateGeometry(direction) {
    if (!GEO) {
      return;
    }

    geometryState = GEO.rotateQuarter(geometryState, direction);
    applyGeometryChange();
  }

  function flipGeometry(axis) {
    if (!GEO) {
      return;
    }

    geometryState = GEO.toggleFlip(geometryState, axis);
    applyGeometryChange();
  }

  function setGeometryAngle(degrees) {
    if (!GEO) {
      return;
    }

    const value = GEO.clamp(
      Number(degrees) || 0,
      -GEO.MAX_FINE_ANGLE,
      GEO.MAX_FINE_ANGLE,
    );

    geometryState = { ...geometryState, angle: value };
    applyGeometryChange();
  }

  function resetGeometry() {
    geometryState = createDefaultGeometry();
    cropMode = false;
    cropBackup = null;
    cropDrag = null;
    cropAspect = "free";

    if (cropAspectSelect) {
      cropAspectSelect.value = "free";
    }

    updateCropControls();
    applyGeometryChange();
  }

  function applyCropAspect(value) {
    cropAspect = value;

    if (!GEO) {
      return;
    }

    const ratio = cropRatio();

    if (!ratio) {
      return;
    }

    geometryState = {
      ...geometryState,
      crop: GEO.applyAspect(geometryState.crop, ratio, cropBounds()),
    };
    applyGeometryChange();
  }

  /** 色调分离的 uniform 只在状态变化时重算。 */
  function refreshPosterizeUniforms() {
    posterizeUniforms = POSTERIZE
      ? POSTERIZE.resolve(posterizeState)
      : { enabled: false, levels: 8, amount: 0, mode: 0, channels: [1, 1, 1] };

    return posterizeUniforms;
  }

  /** 输出列与控制行的显示文本，白平衡滑条使用自己的单位。 */
  function formatControlValue(key, value) {
    if (key === "wbKelvin") {
      return `${value} K`;
    }

    if (key === "wbStrength") {
      return `${value}%`;
    }

    if (key === "wbGainR" || key === "wbGainG" || key === "wbGainB") {
      return `${channelGainFactor(value).toFixed(2)}×`;
    }

    if (key === "posterizeLevels") {
      return `${value} 级`;
    }

    if (key === "posterizeAmount") {
      return `${value}%`;
    }

    return formatValue(value, BIPOLAR_KEYS.has(key));
  }

  /* ------------------------------------------------------------------ *
   * 数字输入框：每个滑条都能直接键入数值
   * ------------------------------------------------------------------ */

  /** 增益滑条在数字框里显示倍率，其余滑条显示滑条原值。 */
  function numberFieldValue(key, sliderValue) {
    if (key === "wbGainR" || key === "wbGainG" || key === "wbGainB") {
      return channelGainFactor(sliderValue).toFixed(2);
    }

    return String(Math.round(Number(sliderValue)));
  }

  /** 数字框里键入的值 → 滑条原值。 */
  function sliderValueFromField(key, fieldValue) {
    if (key === "wbGainR" || key === "wbGainG" || key === "wbGainB") {
      const factor = Math.max(0.05, Number(fieldValue));

      return 50 * Math.log2(factor);
    }

    return Number(fieldValue);
  }

  /** 设置数字框的取值范围（增益滑条用倍率范围）。 */
  function configureNumberField(key) {
    const { input, number } = controls.get(key);

    if (!number) {
      return;
    }

    if (key === "wbGainR" || key === "wbGainG" || key === "wbGainB") {
      number.min = "0.25";
      number.max = "4";
      number.step = "0.05";
      return;
    }

    number.min = input.min;
    number.max = input.max;
    number.step = input.step || "1";
  }

  /** 让数字框跟随滑条；正在输入时不要打断用户。 */
  function syncNumberField(key) {
    const { input, number } = controls.get(key);

    if (!number || document.activeElement === number) {
      return;
    }

    const value = numberFieldValue(key, Number(input.value));

    if (number.value !== value) {
      number.value = value;
    }
  }

  function applyNumberField(key) {
    const { input, number } = controls.get(key);

    if (!number || number.value.trim() === "") {
      return;
    }

    const parsed = sliderValueFromField(key, number.value);

    if (!Number.isFinite(parsed)) {
      return;
    }

    const minimum = Number(input.min);
    const maximum = Number(input.max);

    if (parsed < minimum || parsed > maximum) {
      return;
    }

    applySliderValue(key, String(parsed));
  }

  function commitNumberField(key) {
    const { input, number } = controls.get(key);

    if (!number) {
      return;
    }

    const parsed = sliderValueFromField(key, number.value);

    if (!Number.isFinite(parsed)) {
      number.value = numberFieldValue(key, Number(input.value));

      return;
    }

    const clamped = Math.max(
      Number(input.min),
      Math.min(Number(input.max), parsed),
    );

    applySliderValue(key, String(clamped));
    number.value = numberFieldValue(key, Number(input.value));
  }

  function describeControlValue(key, value) {
    if (key === "wbKelvin") {
      return `色温 ${value} K`;
    }

    if (key === "wbTint") {
      if (value > 0) {
        return `偏品红 ${value}`;
      }

      return value < 0 ? `偏绿 ${-value}` : "无色调偏移";
    }

    if (key === "wbStrength") {
      return `白平衡强度 ${value}%`;
    }

    if (key === "wbGainR" || key === "wbGainG" || key === "wbGainB") {
      const channel = key === "wbGainR" ? "红" : key === "wbGainG" ? "绿" : "蓝";

      return `${channel}通道 ${channelGainFactor(value).toFixed(2)} 倍`;
    }

    if (key === "posterizeLevels") {
      return `分离级数 ${value}`;
    }

    if (key === "posterizeAmount") {
      return `色调分离强度 ${value}%`;
    }

    if (BIPOLAR_KEYS.has(key)) {
      return `${value > 0 ? "增加" : value < 0 ? "降低" : "无调整"} ${Math.abs(value)}`;
    }

    return String(value);
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || "着色器编译失败");
    }

    return shader;
  }

  function buildVertexShaderSource(webgl2) {
    return `${
      webgl2 ? "#version 300 es\n" : ""
    }precision highp float;
    ${webgl2 ? "in" : "attribute"} vec2 a_position;
    ${webgl2 ? "out" : "varying"} vec2 v_uv;

    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
    `;
  }

  function buildFragmentShaderSource(webgl2, integerTexture) {
    const version = webgl2 ? "#version 300 es\n" : "";
    const varying = webgl2 ? "in vec2 v_uv;" : "varying vec2 v_uv;";
    const output = webgl2 ? "out vec4 out_color;" : "";
    const fragmentOutput = webgl2 ? "out_color" : "gl_FragColor";
    const samplerType = integerTexture ? "usampler2D" : "sampler2D";
    // GLSL ES 3.00 用 texture()，GLSL ES 1.00 用 texture2D()
    const sampler = webgl2 ? "texture" : "texture2D";
    const samplerPrecision =
      integerTexture && webgl2 ? "precision highp usampler2D;" : "";

    let readPixel;
    let centerTexel;
    let centerAlpha;

    if (integerTexture) {
      readPixel = `
        ivec2 size = textureSize(u_image, 0);
        ivec2 point = ivec2(
          clamp(x, 0, size.x - 1),
          clamp(y, 0, size.y - 1)
        );
        return vec3(texelFetch(u_image, point, 0).rgb) / 65535.0;
      `;
      // 16 位纹理没有翻转 y，纹素行号要反过来数
      centerTexel = `
        ivec2 size = textureSize(u_image, 0);
        vec2 source = sourcePoint();
        return ivec2(
          clamp(int(floor(source.x)), 0, size.x - 1),
          clamp(size.y - 1 - int(floor(source.y)), 0, size.y - 1)
        );
      `;
      centerAlpha = "return 1.0;";
    } else if (webgl2) {
      readPixel = `
        ivec2 size = textureSize(u_image, 0);
        ivec2 point = ivec2(
          clamp(x, 0, size.x - 1),
          clamp(y, 0, size.y - 1)
        );
        return texelFetch(u_image, point, 0).rgb;
      `;
      centerTexel = `
        ivec2 size = textureSize(u_image, 0);
        vec2 source = sourcePoint();
        return ivec2(
          clamp(int(floor(source.x)), 0, size.x - 1),
          clamp(int(floor(source.y)), 0, size.y - 1)
        );
      `;
      centerAlpha = `
        return texelFetch(u_image, centerTexel(), 0).a;
      `;
    } else {
      readPixel = `
        vec2 point = vec2(
          clamp(float(x), 0.0, u_textureSize.x - 1.0),
          clamp(float(y), 0.0, u_textureSize.y - 1.0)
        );
        return texture2D(u_image, (point + 0.5) / u_textureSize).rgb;
      `;
      // GLSL ES 1.00 的 clamp 只有浮点重载，没有整数版本
      centerTexel = `
        vec2 source = sourcePoint();
        return ivec2(
          int(clamp(floor(source.x), 0.0, u_textureSize.x - 1.0)),
          int(clamp(floor(source.y), 0.0, u_textureSize.y - 1.0))
        );
      `;
      centerAlpha = `
        vec2 uv = (vec2(centerTexel()) + 0.5) / u_textureSize;
        return texture2D(u_image, uv).a;
      `;
    }

    return `${version}precision highp float;
    precision highp int;
    ${samplerPrecision}

    ${varying}
    ${output}
    uniform ${samplerType} u_image;
    uniform vec2 u_textureSize;
    uniform vec2 u_outputSize;
    uniform mat3 u_viewMatrix;
    uniform float u_saturation;
    uniform float u_hueShift;
    uniform float u_vibrance;
    uniform float u_brightness;
    uniform float u_exposure;
    uniform float u_contrast;
    uniform float u_temperature;
    uniform float u_whiteBalance;
    uniform float u_shadows;
    uniform float u_highlights;
    uniform float u_denoise;
    uniform float u_detail;
    uniform mat3 u_wbMatrix;
    uniform float u_wbMatrixOn;
    uniform float u_wbLegacyOn;
    uniform sampler2D u_curveComposite;
    uniform sampler2D u_curveChannel;
    uniform float u_curvesOn;
    uniform float u_curveChannelsOn;
    uniform float u_posterizeLevels;
    uniform float u_posterizeAmount;
    uniform float u_posterizeMode;
    uniform vec3 u_posterizeChannels;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

    /**
     * 输出像素中心对应的源图采样坐标（x 向右，y 自图像底部向上，单位是纹素）。
     * u_viewMatrix 由 geometry.js 求出：恒等时就是 (W * u, H * v)，
     * 旋转 / 翻转 / 裁切都体现在这个矩阵里。
     */
    vec2 sourcePoint() {
      return (u_viewMatrix * vec3(gl_FragCoord.xy / u_outputSize, 1.0)).xy;
    }

    /** 采样点是否落在原图范围内（旋转后的空白角会落在外面）。 */
    bool insideSource(vec2 point) {
      return point.x >= 0.0 && point.x <= u_textureSize.x &&
        point.y >= 0.0 && point.y <= u_textureSize.y;
    }

    vec3 readPixel(int x, int y) {
      ${readPixel}
    }

    ivec2 centerTexel() {
      ${centerTexel}
    }

    vec3 readCenter() {
      ivec2 point = centerTexel();
      return readPixel(point.x, point.y);
    }

    float readCenterAlpha() {
      ${centerAlpha}
    }

    vec3 bilateralFilter(vec3 center) {
      if (u_denoise <= 0.0001) {
        return center;
      }

      ivec2 origin = centerTexel();
      float centerLuma = dot(center, LUMA);
      float rangeSigma = mix(0.035, 0.16, clamp(u_detail, 0.0, 1.0));
      float rangeDivisor = 2.0 * rangeSigma * rangeSigma;
      float blend = clamp(
        u_denoise * mix(1.0, 0.35, clamp(u_detail, 0.0, 1.0)),
        0.0,
        1.0
      );
      vec3 sum = vec3(0.0);
      float totalWeight = 0.0;

      for (int y = -2; y <= 2; y += 1) {
        for (int x = -2; x <= 2; x += 1) {
          vec3 sampleColor = readPixel(origin.x + x, origin.y + y);
          float lumaDelta = dot(sampleColor, LUMA) - centerLuma;
          float spatialWeight = exp(-float(x * x + y * y) * 0.32);
          float rangeWeight = exp(
            -(lumaDelta * lumaDelta) / rangeDivisor
          );
          float weight = spatialWeight * rangeWeight;

          sum += sampleColor * weight;
          totalWeight += weight;
        }
      }

      return mix(center, sum / max(totalWeight, 0.0001), blend);
    }

    vec3 detailEnhance(vec3 center, vec3 filtered) {
      if (u_detail <= 0.0001) {
        return filtered;
      }

      ivec2 origin = centerTexel();
      vec3 localBlur = vec3(0.0);
      float totalWeight = 0.0;

      for (int y = -2; y <= 2; y += 1) {
        for (int x = -2; x <= 2; x += 1) {
          float weight = exp(-float(x * x + y * y) * 0.24);
          localBlur += readPixel(origin.x + x, origin.y + y) * weight;
          totalWeight += weight;
        }
      }

      vec3 detail = center - localBlur / totalWeight;
      vec3 magnitude = abs(detail);
      vec3 noiseGate = smoothstep(
        vec3(0.003),
        vec3(0.014 + 0.026 * clamp(u_denoise, 0.0, 1.0)),
        magnitude
      );
      float detailGain = mix(0.95, 1.85, clamp(u_denoise, 0.0, 1.0));

      return clamp(
        filtered + detail * noiseGate * u_detail * detailGain,
        0.0,
        1.0
      );
    }

    vec3 shiftHue(vec3 color, float amount) {
      if (abs(amount) < 0.0001) {
        return color;
      }

      float y = dot(color, vec3(0.299, 0.587, 0.114));
      float i = dot(color, vec3(0.595716, -0.274453, -0.321263));
      float q = dot(color, vec3(0.211456, -0.522591, 0.311135));
      float angle = atan(q, i) + amount * 3.14159265;
      float chroma = length(vec2(i, q));
      i = chroma * cos(angle);
      q = chroma * sin(angle);

      return vec3(
        y + 0.9563 * i + 0.6210 * q,
        y - 0.2721 * i - 0.6474 * q,
        y - 1.1070 * i + 1.7046 * q
      );
    }

    vec3 srgbToLinear(vec3 color) {
      return mix(
        color / 12.92,
        pow((color + 0.055) / 1.055, vec3(2.4)),
        step(vec3(0.04045), color)
      );
    }

    vec3 linearToSrgb(vec3 color) {
      vec3 safe = max(color, vec3(0.0));

      return mix(
        safe * 12.92,
        1.055 * pow(safe, vec3(1.0 / 2.4)) - 0.055,
        step(vec3(0.0031308), safe)
      );
    }

    /**
     * 白平衡：把由「白平衡方式」算出的色适应矩阵作用在线性光上。
     * 矩阵在 CPU 侧由 white-balance.js 求出（色温轨迹 + Bradford 色适应、
     * 自动光源估计、灰点取样、RGB 增益都会归一到同一个矩阵）。
     */
    vec3 applyWhiteBalance(vec3 color) {
      if (u_wbMatrixOn < 0.5) {
        return color;
      }

      return linearToSrgb(u_wbMatrix * srgbToLinear(color));
    }

    /**
     * 曲线：用 256 级查找表按通道映射明暗。
     * 复合曲线作用在 R/G/B 上，之后单通道曲线再各自映射一次，
     * 与 Photoshop 里 RGB 通道优先于单通道的次序一致。
     */
    vec3 applyCurves(vec3 color) {
      vec3 mapped = clamp(color, 0.0, 1.0);

      if (u_curvesOn > 0.5) {
        mapped = vec3(
          ${sampler}(u_curveComposite, vec2(mapped.r, 0.5)).r,
          ${sampler}(u_curveComposite, vec2(mapped.g, 0.5)).r,
          ${sampler}(u_curveComposite, vec2(mapped.b, 0.5)).r
        );
      }

      if (u_curveChannelsOn > 0.5) {
        mapped = vec3(
          ${sampler}(u_curveChannel, vec2(mapped.r, 0.5)).r,
          ${sampler}(u_curveChannel, vec2(mapped.g, 0.5)).g,
          ${sampler}(u_curveChannel, vec2(mapped.b, 0.5)).b
        );
      }

      return mapped;
    }

    /** 把一个 0..1 的值量化到 N 段，黑白场保持不变。 */
    float posterizeStep(float value, float levels) {
      float steps = max(2.0, levels);

      return floor(clamp(value, 0.0, 1.0) * (steps - 1.0) + 0.5) / (steps - 1.0);
    }

    /**
     * 色调分离：
     * 按亮度时只量化亮度，再按比例缩放 RGB，保留色相与饱和度；
     * 按通道时 R/G/B 各自量化，u_posterizeChannels 控制哪些通道参与。
     */
    vec3 applyPosterize(vec3 color) {
      if (u_posterizeAmount <= 0.0001) {
        return color;
      }

      float levels = max(2.0, u_posterizeLevels);
      vec3 banded;

      if (u_posterizeMode < 0.5) {
        float luma = dot(color, LUMA);
        float target = posterizeStep(luma, levels);
        // 暗部放大倍数设上限，避免把噪点放大成色块
        float scale = clamp(target / max(luma, 0.015), 0.0, 8.0);

        banded = clamp(color * scale, 0.0, 1.0);
      } else {
        banded = vec3(
          mix(color.r, posterizeStep(color.r, levels), u_posterizeChannels.r),
          mix(color.g, posterizeStep(color.g, levels), u_posterizeChannels.g),
          mix(color.b, posterizeStep(color.b, levels), u_posterizeChannels.b)
        );
      }

      return mix(color, banded, clamp(u_posterizeAmount, 0.0, 1.0));
    }

    vec3 adjustColor(vec3 color) {
      color = applyWhiteBalance(color);

      color *= exp2(u_exposure * 1.5);
      color += u_brightness * 0.32;

      if (u_wbLegacyOn > 0.5) {
        color.r += u_temperature * 0.14 * (1.0 - color.r);
        color.b -= u_temperature * 0.14 * color.b;

        color.r += u_whiteBalance * 0.1 * (1.0 - color.r);
        color.b += u_whiteBalance * 0.1 * (1.0 - color.b);
        color.g -= u_whiteBalance * 0.16 * color.g;
      }

      color = shiftHue(color, u_hueShift);
      color = (color - 0.5) * (1.0 + u_contrast * 1.15) + 0.5;

      float luminance = dot(color, LUMA);
      color = mix(vec3(luminance), color, max(0.0, 1.0 + u_saturation));

      float high = max(color.r, max(color.g, color.b));
      float low = min(color.r, min(color.g, color.b));
      float chroma = high - low;
      float vibranceWeight = 1.0 - smoothstep(0.0, 0.75, chroma);

      luminance = dot(color, LUMA);
      color = mix(
        vec3(luminance),
        color,
        max(0.0, 1.0 + u_vibrance * 0.9 * vibranceWeight)
      );

      luminance = dot(color, LUMA);
      float shadowMask = 1.0 - smoothstep(0.0, 0.65, luminance);
      color += u_shadows * 0.34 * shadowMask * (0.65 + 0.35 * (1.0 - luminance));

      // 高光与阴影成对：正值提亮亮部，负值压暗（等效于恢复高光）
      luminance = dot(color, LUMA);
      float highlightMask = smoothstep(0.35, 1.0, luminance);
      color += u_highlights * 0.34 * highlightMask * (0.65 + 0.35 * luminance);

      color = applyCurves(color);
      color = applyPosterize(color);

      return clamp(color, 0.0, 1.0);
    }

    void main() {
      vec2 point = sourcePoint();

      // 旋转后的画布四角没有内容：直接输出透明，让画布底纹透出来
      if (!insideSource(point)) {
        ${fragmentOutput} = vec4(0.0);
        return;
      }

      vec3 center = readCenter();
      vec3 color = detailEnhance(center, bilateralFilter(center));
      color = adjustColor(color);
      ${fragmentOutput} = vec4(color, readCenterAlpha());
    }
    `;
  }

  function supportsWebGL2() {
    if (webgl2Supported !== null) {
      return webgl2Supported;
    }

    try {
      webgl2Supported = Boolean(
        document.createElement("canvas").getContext("webgl2"),
      );
    } catch {
      webgl2Supported = false;
    }

    return webgl2Supported;
  }

  /** 256x1 的查找表纹理，供曲线使用。 */
  function createCurveLutTexture(gl) {
    const texture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(1024),
    );

    return texture;
  }

  function createRenderer(canvas, options = {}) {    const preserveDrawingBuffer = Boolean(options.preserveDrawingBuffer);
    const sourceKind = options.sourceKind || "image";
    const attributes = {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer,
      stencil: false,
    };
    let gl = canvas.getContext("webgl2", attributes);
    const webgl2 = Boolean(gl);

    if (!gl) {
      if (sourceKind === "u16") {
        throw new Error("当前浏览器不支持 WebGL2，无法使用 16 位 RAW 管线");
      }

      gl = canvas.getContext("webgl", attributes);
    }

    if (!gl) {
      throw new Error("当前浏览器不支持 WebGL");
    }

    const integerTexture = sourceKind === "u16";
    const vertexShader = compileShader(
      gl,
      gl.VERTEX_SHADER,
      buildVertexShaderSource(webgl2),
    );
    const fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      buildFragmentShaderSource(webgl2, integerTexture),
    );
    const program = gl.createProgram();

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(message || "WebGL 程序链接失败");
    }

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const positionBuffer = gl.createBuffer();

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      image: gl.getUniformLocation(program, "u_image"),
      textureSize: gl.getUniformLocation(program, "u_textureSize"),
      outputSize: gl.getUniformLocation(program, "u_outputSize"),
      viewMatrix: gl.getUniformLocation(program, "u_viewMatrix"),
      wbMatrix: gl.getUniformLocation(program, "u_wbMatrix"),
      wbMatrixOn: gl.getUniformLocation(program, "u_wbMatrixOn"),
      wbLegacyOn: gl.getUniformLocation(program, "u_wbLegacyOn"),
      curveComposite: gl.getUniformLocation(program, "u_curveComposite"),
      curveChannel: gl.getUniformLocation(program, "u_curveChannel"),
      curvesOn: gl.getUniformLocation(program, "u_curvesOn"),
      curveChannelsOn: gl.getUniformLocation(program, "u_curveChannelsOn"),
      posterizeLevels: gl.getUniformLocation(program, "u_posterizeLevels"),
      posterizeAmount: gl.getUniformLocation(program, "u_posterizeAmount"),
      posterizeMode: gl.getUniformLocation(program, "u_posterizeMode"),
      posterizeChannels: gl.getUniformLocation(program, "u_posterizeChannels"),
    };

    for (const key of CONTROL_KEYS) {
      uniforms[key] = gl.getUniformLocation(program, `u_${key}`);
    }

    const curveTextures = [createCurveLutTexture(gl), createCurveLutTexture(gl)];

    gl.useProgram(program);
    gl.uniform1i(uniforms.image, 0);
    gl.uniform1i(uniforms.curveComposite, 1);
    gl.uniform1i(uniforms.curveChannel, 2);
    gl.clearColor(0, 0, 0, 0);

    return {
      canvas,
      gl,
      program,
      uniforms,
      texture: null,
      textureWidth: 0,
      textureHeight: 0,
      sourceKind,
      webgl2,
      curveTextures,
      curveRevision: -1,
    };
  }

  function destroyRenderer(renderer) {
    if (!renderer) {
      return;
    }

    const { gl } = renderer;

    if (renderer.texture) {
      gl.deleteTexture(renderer.texture);
    }

    for (const texture of renderer.curveTextures || []) {
      gl.deleteTexture(texture);
    }

    gl.deleteProgram(renderer.program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** 曲线变化后重新上传查找表。 */
  function uploadCurveTextures(renderer) {
    if (renderer.curveRevision === curveLutRevision) {
      return;
    }

    const { gl } = renderer;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, renderer.curveTextures[0]);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      curveCompositeLut,
    );

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, renderer.curveTextures[1]);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      curveChannelLut,
    );

    renderer.curveRevision = curveLutRevision;
  }

  function getTextureFormat(gl, channels) {
    if (channels === 1) {
      return { internal: gl.R16UI, format: gl.RED_INTEGER };
    }

    if (channels === 2) {
      return { internal: gl.RG16UI, format: gl.RG_INTEGER };
    }

    if (channels === 4) {
      return { internal: gl.RGBA16UI, format: gl.RGBA_INTEGER };
    }

    return { internal: gl.RGB16UI, format: gl.RGB_INTEGER };
  }

  function setRendererTexture(renderer, source) {
    const { gl } = renderer;

    if (source.kind !== renderer.sourceKind) {
      throw new Error("渲染纹理类型与当前管线不一致");
    }

    gl.activeTexture(gl.TEXTURE0);

    if (!renderer.texture) {
      renderer.texture = gl.createTexture();
    }

    gl.bindTexture(gl.TEXTURE_2D, renderer.texture);

    if (renderer.textureSource === source) {
      return;
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      source.kind === "u16" ? gl.NEAREST : gl.LINEAR,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      source.kind === "u16" ? gl.NEAREST : gl.LINEAR,
    );

    if (source.kind === "u16") {
      if (!renderer.webgl2) {
        throw new Error("16 位纹理需要 WebGL2");
      }

      const textureFormat = getTextureFormat(gl, source.channels);

      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        textureFormat.internal,
        source.width,
        source.height,
        0,
        textureFormat.format,
        gl.UNSIGNED_SHORT,
        source.data,
      );
    } else {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        renderer.webgl2 ? gl.RGBA8 : gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source.image,
      );
    }

    renderer.textureWidth = source.width;
    renderer.textureHeight = source.height;
    renderer.textureSource = source;
  }

  function renderWithRenderer(renderer, width, height, currentSettings, wbState, geometry) {
    const { canvas, gl, program, uniforms } = renderer;
    const balance = wbState || getWhiteBalanceResult();

    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
    gl.uniform2f(
      uniforms.textureSize,
      renderer.textureWidth,
      renderer.textureHeight,
    );
    gl.uniform2f(uniforms.outputSize, width, height);
    // 旋转 / 翻转 / 裁切：输出坐标 → 源图纹理坐标（恒等时就是纹理尺寸的对角矩阵）
    gl.uniformMatrix3fv(
      uniforms.viewMatrix,
      false,
      GEO && geometry
        ? GEO.viewMatrix(renderer.textureWidth, renderer.textureHeight, geometry)
        : identityViewMatrix(renderer.textureWidth, renderer.textureHeight),
    );

    for (const key of CONTROL_KEYS) {
      gl.uniform1f(uniforms[key], currentSettings[key]);
    }

    gl.uniformMatrix3fv(uniforms.wbMatrix, false, balance.columnMajor);
    gl.uniform1f(uniforms.wbMatrixOn, balance.enabled ? 1 : 0);
    gl.uniform1f(uniforms.wbLegacyOn, balance.mode === "manual" ? 1 : 0);

    uploadCurveTextures(renderer);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, renderer.curveTextures[0]);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, renderer.curveTextures[1]);
    gl.uniform1f(uniforms.curvesOn, curveUniforms.compositeOn);
    gl.uniform1f(uniforms.curveChannelsOn, curveUniforms.channelsOn);

    gl.uniform1f(uniforms.posterizeLevels, posterizeUniforms.levels);
    gl.uniform1f(
      uniforms.posterizeAmount,
      posterizeUniforms.enabled ? posterizeUniforms.amount : 0,
    );
    gl.uniform1f(uniforms.posterizeMode, posterizeUniforms.mode);
    gl.uniform3f(
      uniforms.posterizeChannels,
      posterizeUniforms.channels[0],
      posterizeUniforms.channels[1],
      posterizeUniforms.channels[2],
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function calculatePreviewSize(width, height) {
    const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height));

    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function getSourceDimensions(source) {
    if (source.kind === "image") {
      return {
        width: source.image.naturalWidth || source.image.width,
        height: source.image.naturalHeight || source.image.height,
      };
    }

    return { width: source.width, height: source.height };
  }

  function rawImageDataToU16Source(rawImage) {
    const width = Number(rawImage?.width);
    const height = Number(rawImage?.height);
    const bits = Number(rawImage?.bits) || 8;
    const data = rawImage?.data;

    if (!width || !height || !data?.length) {
      throw new Error("RAW 解码结果为空");
    }

    const pixelCount = width * height;
    const bytesPerSample = bits > 8 ? 2 : 1;
    const declaredDataSize =
      Number(rawImage.dataSize) || Number(data.byteLength) || data.length;
    let channels = Math.floor(
      declaredDataSize / (pixelCount * bytesPerSample),
    );

    if (channels < 3 || channels > 4) {
      channels = Number(rawImage.colors) === 4 ? 4 : 3;
    }

    const sourceLength =
      bits > 8 && !(data instanceof Uint16Array)
        ? Math.floor(data.byteLength / bytesPerSample)
        : data.length;
    const requiredLength = pixelCount * channels;

    if (sourceLength < requiredLength) {
      throw new Error("RAW 解码数据长度不正确");
    }

    let source;

    if (bits > 8) {
      if (data instanceof Uint16Array) {
        source =
          data.length === requiredLength
            ? data
            : new Uint16Array(data.buffer, data.byteOffset, requiredLength);
      } else {
        source = new Uint16Array(
          data.buffer,
          data.byteOffset,
          requiredLength,
        );
      }
    } else {
      source = new Uint16Array(requiredLength);

      for (let index = 0; index < requiredLength; index += 1) {
        source[index] = data[index] * 257;
      }
    }

    return {
      kind: "u16",
      width,
      height,
      channels,
      data: source,
      fallback8Source: null,
    };
  }

  function downsampleU16Source(source, width, height) {
    if (source.width === width && source.height === height) {
      return source;
    }

    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const channels = source.channels;
    const output = new Uint16Array(width * height * channels);
    const sourceData = source.data;

    for (let targetY = 0; targetY < height; targetY += 1) {
      const sourceTop = Math.floor((targetY * sourceHeight) / height);
      const sourceBottom = Math.max(
        sourceTop + 1,
        Math.floor(((targetY + 1) * sourceHeight) / height),
      );

      for (let targetX = 0; targetX < width; targetX += 1) {
        const sourceLeft = Math.floor((targetX * sourceWidth) / width);
        const sourceRight = Math.max(
          sourceLeft + 1,
          Math.floor(((targetX + 1) * sourceWidth) / width),
        );
        const sums = [0, 0, 0, 0];
        let sampleCount = 0;

        for (let sourceY = sourceTop; sourceY < sourceBottom; sourceY += 1) {
          let sourceIndex =
            (sourceY * sourceWidth + sourceLeft) * channels;

          for (let sourceX = sourceLeft; sourceX < sourceRight; sourceX += 1) {
            for (let channel = 0; channel < channels; channel += 1) {
              sums[channel] += sourceData[sourceIndex + channel];
            }

            sourceIndex += channels;
            sampleCount += 1;
          }
        }

        const targetIndex = (targetY * width + targetX) * channels;

        for (let channel = 0; channel < channels; channel += 1) {
          output[targetIndex + channel] = Math.round(
            sums[channel] / sampleCount,
          );
        }
      }
    }

    return {
      kind: "u16",
      width,
      height,
      channels,
      data: output,
      fallback8Source: null,
    };
  }

  function u16SourceToCanvas(source) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: source.channels === 4 });
    const { width, height, channels, data } = source;

    canvas.width = width;
    canvas.height = height;
    const tileHeight = Math.max(
      1,
      Math.min(height, Math.floor(1048576 / width)),
    );

    for (let tileTop = 0; tileTop < height; tileTop += tileHeight) {
      const rows = Math.min(tileHeight, height - tileTop);
      const rgba = new Uint8ClampedArray(width * rows * 4);

      for (let row = 0; row < rows; row += 1) {
        const firstPixel = (tileTop + row) * width;

        for (let column = 0; column < width; column += 1) {
          const pixel = firstPixel + column;
          const sourceIndex = pixel * channels;
          const targetIndex = (row * width + column) * 4;

          rgba[targetIndex] = Math.round(data[sourceIndex] / 257);
          rgba[targetIndex + 1] = Math.round(data[sourceIndex + 1] / 257);
          rgba[targetIndex + 2] = Math.round(data[sourceIndex + 2] / 257);
          rgba[targetIndex + 3] =
            channels === 4 ? Math.round(data[sourceIndex + 3] / 257) : 255;
        }
      }

      context.putImageData(new ImageData(rgba, width, rows), 0, tileTop);
    }

    return canvas;
  }

  function prepareRenderableSource(source) {
    if (source.kind !== "u16" || supportsWebGL2()) {
      return source;
    }

    if (!source.fallback8Source) {
      source.fallback8Source = {
        kind: "image",
        width: source.width,
        height: source.height,
        image: u16SourceToCanvas(source),
      };
    }

    return source.fallback8Source;
  }

  function createPreviewState(source) {
    const size = calculatePreviewSize(source.width, source.height);

    if (source.kind === "u16") {
      const previewSource = downsampleU16Source(
        source,
        size.width,
        size.height,
      );

      return {
        textureSource: previewSource,
        displayCanvas: u16SourceToCanvas(previewSource),
        size,
      };
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });

    canvas.width = size.width;
    canvas.height = size.height;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source.image, 0, 0, size.width, size.height);

    return {
      textureSource: {
        kind: "image",
        width: size.width,
        height: size.height,
        image: canvas,
      },
      displayCanvas: canvas,
      size,
    };
  }

  function createScaledRenderSource(source, width, height) {
    if (source.kind === "u16") {
      return downsampleU16Source(source, width, height);
    }

    const dimensions = getSourceDimensions(source);

    if (dimensions.width === width && dimensions.height === height) {
      return source;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });

    canvas.width = width;
    canvas.height = height;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source.image, 0, 0, width, height);

    return { kind: "image", width, height, image: canvas };
  }

  function canvasToBlob(canvas, mimeType, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("导出图片失败"));
          }
        },
        mimeType,
        quality,
      );
    });
  }

  function schedulePreviewRender() {
    if (frameRequest) {
      return;
    }

    frameRequest = window.requestAnimationFrame(() => {
      frameRequest = 0;
      renderPreview();
    });
  }

  /* ------------------------------------------------------------------ *
   * 白平衡：状态 → 色适应矩阵 → 界面
   * ------------------------------------------------------------------ */

  const ANALYSIS_MAX_EDGE = 320;
  const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const GRAY_POINT_HINT = "在左侧原图上点击中性灰或白色区域即可取色，可反复点击";

  /** 供自动白平衡使用的缩略图统计缓冲（线性光）。 */
  function buildAnalysisBuffer() {
    if (!WB || !previewDisplayCanvas || !frameSize.width || !frameSize.height) {
      return null;
    }

    const scale = Math.min(
      1,
      ANALYSIS_MAX_EDGE / Math.max(frameSize.width, frameSize.height),
    );
    const width = Math.max(1, Math.round(frameSize.width * scale));
    const height = Math.max(1, Math.round(frameSize.height * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    canvas.width = width;
    canvas.height = height;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "medium";
    context.drawImage(previewDisplayCanvas, 0, 0, width, height);

    return WB.createAnalysisBuffer(
      context.getImageData(0, 0, width, height).data,
      width,
      height,
    );
  }

  function getAnalysisBuffer() {
    if (analysisCache.revision === sourceRevision && analysisCache.buffer) {
      return analysisCache.buffer;
    }

    analysisCache = { revision: sourceRevision, buffer: buildAnalysisBuffer() };
    return analysisCache.buffer;
  }

  function whiteBalanceSignature() {
    const sample = whiteBalance.sample;

    return [
      whiteBalance.mode,
      whiteBalance.kelvin,
      whiteBalance.tint,
      whiteBalance.preset,
      whiteBalance.algorithm,
      whiteBalance.strength,
      whiteBalance.catSpace,
      whiteBalance.gains.r,
      whiteBalance.gains.g,
      whiteBalance.gains.b,
      sample ? `${sample.x}:${sample.y}` : "-",
      sourceRevision,
    ].join("|");
  }

  /** 取得当前白平衡结果（含 3x3 矩阵），结果按签名缓存。 */
  function getWhiteBalanceResult() {
    const key = whiteBalanceSignature();

    if (whiteBalanceResult && whiteBalanceCacheKey === key) {
      return whiteBalanceResult;
    }

    if (!WB) {
      whiteBalanceResult = {
        enabled: false,
        mode: whiteBalance.mode,
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        columnMajor: IDENTITY_MATRIX,
        illuminantXy: null,
        effectiveKelvin: 0,
        equivalentTint: 0,
        detail: "白平衡模块未载入",
      };
      whiteBalanceCacheKey = key;
      return whiteBalanceResult;
    }

    const analysis = whiteBalance.mode === "auto" ? getAnalysisBuffer() : null;

    whiteBalanceResult = WB.resolve(whiteBalance, analysis);
    whiteBalanceCacheKey = key;
    return whiteBalanceResult;
  }

  function invalidateWhiteBalance() {
    whiteBalanceResult = null;
    whiteBalanceCacheKey = "";
  }

  function updateWhiteBalanceRowVisibility() {
    const mode = whiteBalance.mode;

    for (const row of wbModeRows) {
      const modes = (row.dataset.wbMode || "").split(/\s+/).filter(Boolean);

      row.hidden = !modes.includes(mode);
    }

    const picking = mode === "grayPoint" && Boolean(currentSource);

    for (const panel of previewPanels) {
      panel.classList.toggle("is-picking", picking);
    }

    // 行的显隐会改变面板自然高度，需要重新评估
    updateControlsHeight();
  }

  function ensureGrayPointMarkers() {
    if (grayPointMarker) {
      return grayPointMarker;
    }

    grayPointMarker = previewPanels.map((panel) => {
      const marker = document.createElement("span");

      marker.className = "neutral-picker-mark";
      marker.hidden = true;
      marker.setAttribute("aria-hidden", "true");
      panel.append(marker);
      return { panel, marker };
    });

    return grayPointMarker;
  }

  function canvasDisplayMetrics(canvas) {
    if (!canvas || !canvas.width || !canvas.height) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return null;
    }

    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);

    return {
      rect,
      scale,
      offsetX: (rect.width - canvas.width * scale) / 2,
      offsetY: (rect.height - canvas.height * scale) / 2,
    };
  }

  function updateGrayPointMarker() {
    const markers = ensureGrayPointMarkers();
    const sample = whiteBalance.mode === "grayPoint" ? whiteBalance.sample : null;
    const geometry = getRenderGeometry();

    for (const { panel, marker } of markers) {
      const canvas = panel.querySelector(".preview-canvas");
      const metrics = canvas ? canvasDisplayMetrics(canvas) : null;

      if (!sample || !metrics || !previewSize.width || !GEO) {
        marker.hidden = true;
        continue;
      }

      // 灰点存的是原图坐标，画面旋转裁切后要重新投影回当前视图
      const visible = GEO.isSourcePointVisible(
        frameSize.width,
        frameSize.height,
        geometry,
        previewSize.width,
        previewSize.height,
        sample.x + 0.5,
        sample.y + 0.5,
      );
      const point = visible
        ? GEO.sourceToOutput(
            frameSize.width,
            frameSize.height,
            geometry,
            previewSize.width,
            previewSize.height,
            sample.x + 0.5,
            sample.y + 0.5,
          )
        : null;

      if (!point) {
        marker.hidden = true;
        continue;
      }

      const panelRect = panel.getBoundingClientRect();
      const { rect } = metrics;

      marker.hidden = false;
      marker.style.left = `${
        rect.left - panelRect.left + metrics.offsetX + point.x * metrics.scale
      }px`;
      marker.style.top = `${
        rect.top - panelRect.top + metrics.offsetY + point.y * metrics.scale
      }px`;
    }
  }

  /** 把鼠标位置换算成输出画布像素坐标，落在画面外时返回 null。 */
  function mapPointerToPreviewPixel(canvas, event) {
    const metrics = canvasDisplayMetrics(canvas);

    if (!metrics) {
      return null;
    }

    const x = Math.floor(
      (event.clientX - metrics.rect.left - metrics.offsetX) / metrics.scale,
    );
    const y = Math.floor(
      (event.clientY - metrics.rect.top - metrics.offsetY) / metrics.scale,
    );

    if (x < 0 || y < 0 || x >= previewSize.width || y >= previewSize.height) {
      return null;
    }

    return { x, y };
  }

  /** 输出画布像素 → 原图像素（旋转裁切后仍然取到画面上的那一块）。 */
  function mapPreviewPixelToSource(pixel) {
    if (!pixel) {
      return null;
    }

    const geometry = getRenderGeometry();

    if (!GEO || !geometry) {
      return pixel;
    }

    const point = GEO.outputToSource(
      frameSize.width,
      frameSize.height,
      geometry,
      previewSize.width,
      previewSize.height,
      pixel.x + 0.5,
      pixel.y + 0.5,
    );

    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= frameSize.width ||
      point.y >= frameSize.height
    ) {
      return null;
    }

    return { x: Math.floor(point.x), y: Math.floor(point.y) };
  }

  /** 取 5x5 邻域的平均颜色（转成线性光），提高拾色稳定性。 */
  function samplePreviewPixel(x, y) {
    if (!WB || !previewDisplayCanvas) {
      return null;
    }

    const radius = 2;
    const left = Math.max(0, x - radius);
    const top = Math.max(0, y - radius);
    const right = Math.min(frameSize.width - 1, x + radius);
    const bottom = Math.min(frameSize.height - 1, y + radius);
    const width = right - left + 1;
    const height = bottom - top + 1;
    const context = previewDisplayCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    const data = context.getImageData(left, top, width, height).data;
    const count = width * height;
    const sums = [0, 0, 0];

    for (let index = 0; index < count; index += 1) {
      sums[0] += data[index * 4];
      sums[1] += data[index * 4 + 1];
      sums[2] += data[index * 4 + 2];
    }

    const srgb = [
      sums[0] / count / 255,
      sums[1] / count / 255,
      sums[2] / count / 255,
    ];
    const linear = WB.srgbTripletToLinear(srgb);

    return { x, y, r: linear[0], g: linear[1], b: linear[2] };
  }

  function pickGrayPoint(event) {
    if (whiteBalance.mode !== "grayPoint" || !currentSource) {
      return;
    }

    const pixel = mapPointerToPreviewPixel(event.currentTarget, event);
    const source = mapPreviewPixelToSource(pixel);

    if (!source) {
      return;
    }

    const sample = samplePreviewPixel(source.x, source.y);

    if (!sample) {
      return;
    }

    whiteBalance.sample = sample;
    invalidateWhiteBalance();
    renderRevision += 1;
    invalidateAiResult();
    updateWhiteBalanceReadout();
    updateGrayPointMarker();
    schedulePreviewRender();
  }

  function grayPointSampleText() {
    const sample = whiteBalance.sample;

    if (!sample) {
      return "";
    }

    // 取样值以线性光存储，显示时再编码回 sRGB，方便和画面上的颜色对照
    const toByte = (value) => {
      const safe = Math.max(0, value);
      const encoded = WB ? WB.linearToSrgb(safe) : safe;

      return Math.round(Math.min(1, encoded) * 255);
    };

    return `R${toByte(sample.r)} G${toByte(sample.g)} B${toByte(sample.b)}`;
  }

  function updateWhiteBalanceReadout() {
    const result = getWhiteBalanceResult();
    const mode = whiteBalance.mode;
    const estimated =
      mode === "auto" || mode === "grayPoint" || mode === "gains";
    let label;

    if (mode === "manual") {
      label = "手动";
    } else if (mode === "off") {
      label = "关闭";
    } else if (result.effectiveKelvin) {
      label = `${estimated ? "≈" : ""}${result.effectiveKelvin}K`;
    } else if (mode === "grayPoint" && !whiteBalance.sample) {
      label = "未取色";
    } else {
      label = "—";
    }

    whiteBalanceModeValue.value = label;
    wbGrayPointValue.value = whiteBalance.sample ? "已取色" : "未取色";

    const sampleText = grayPointSampleText();

    wbGrayPointHint.textContent = sampleText
      ? `已取样 ${sampleText}，在原图上重新点击可换一个取样点`
      : GRAY_POINT_HINT;

    const preset = WB ? WB.findPreset(whiteBalance.preset) : null;

    wbPresetValue.value =
      preset && preset.id !== "custom" ? `${preset.kelvin}K` : "自定义";
    wbAlgorithmValue.value = result.effectiveKelvin
      ? `≈${result.effectiveKelvin}K`
      : "—";

    whiteBalanceModeRow.classList.toggle("is-active", result.enabled);
  }

  function syncWhiteBalanceControls() {
    whiteBalanceModeSelect.value = whiteBalance.mode;
    wbPresetSelect.value = whiteBalance.preset;
    wbAlgorithmSelect.value = whiteBalance.algorithm;
    setSliderValue("wbKelvin", whiteBalance.kelvin);
    setSliderValue("wbTint", whiteBalance.tint);
    setSliderValue("wbStrength", whiteBalance.strength);
    setSliderValue("wbGainR", whiteBalance.gains.r);
    setSliderValue("wbGainG", whiteBalance.gains.g);
    setSliderValue("wbGainB", whiteBalance.gains.b);
    updateWhiteBalanceRowVisibility();
    updateWhiteBalanceReadout();
    updateGrayPointMarker();
  }

  /** 切换白平衡方式后：刷新行可见性并重新渲染。 */
  function applyWhiteBalanceMode(mode) {
    whiteBalance.mode = mode;
    invalidateWhiteBalance();
    renderRevision += 1;
    invalidateAiResult();
    updateWhiteBalanceRowVisibility();
    updateWhiteBalanceReadout();
    updateGrayPointMarker();
    schedulePreviewRender();

    if (mode === "grayPoint" && !whiteBalance.sample) {
      showToast("在左侧原图上点击中性灰或白色区域即可取色");
    } else if (mode === "auto") {
      showToast("已按画面统计自动估计光源");
    }
  }

  function applyWhiteBalancePreset(presetId) {
    const preset = WB ? WB.findPreset(presetId) : null;

    whiteBalance.preset = presetId;

    if (preset && preset.id !== "custom") {
      whiteBalance.kelvin = preset.kelvin;
      whiteBalance.tint = preset.tint;
    }

    invalidateWhiteBalance();
    renderRevision += 1;
    invalidateAiResult();
    syncWhiteBalanceControls();
    schedulePreviewRender();
  }

  function updateWhiteBalanceSetting(key, rawValue) {
    const value = Number(rawValue);

    if (key === "wbKelvin") {
      whiteBalance.kelvin = value;
      whiteBalance.preset = "custom";
    } else if (key === "wbTint") {
      whiteBalance.tint = value;
      whiteBalance.preset = "custom";
    } else if (key === "wbStrength") {
      whiteBalance.strength = value;
    } else if (key === "wbGainR") {
      whiteBalance.gains.r = value;
    } else if (key === "wbGainG") {
      whiteBalance.gains.g = value;
    } else if (key === "wbGainB") {
      whiteBalance.gains.b = value;
    } else {
      return;
    }

    wbPresetSelect.value = whiteBalance.preset;
    invalidateWhiteBalance();
    renderRevision += 1;
    invalidateAiResult();
    updateControlAppearance(key);
    updateWhiteBalanceReadout();
    schedulePreviewRender();
  }

  /* ------------------------------------------------------------------ *
   * 曲线：查找表 → 着色器纹理，以及弹出窗口里的绘制与交互
   * ------------------------------------------------------------------ */

  /** 绘图留白（CSS 像素）与命中半径。 */
  const CURVE_PAD = 10;
  const CURVE_HIT_RADIUS = 11;
  const CURVE_HANDLE_HIT_RADIUS = 9;
  const CURVE_HISTOGRAM_INTERVAL = 180;

  function activeCurvePoints() {
    return curvesState ? curvesState.channels[curvesState.active] : null;
  }

  function setActiveCurve(points) {
    if (curvesState) {
      curvesState.channels[curvesState.active] = points;
    }
  }

  /** 由四条曲线生成两张 256x1 查找表纹理数据。 */
  function rebuildCurveLuts() {
    if (!CURVES || !curvesState) {
      return;
    }

    const composite = CURVES.sampleLut(curvesState.channels.rgb);
    const red = CURVES.sampleLut(curvesState.channels.r);
    const green = CURVES.sampleLut(curvesState.channels.g);
    const blue = CURVES.sampleLut(curvesState.channels.b);

    for (let index = 0; index < 256; index += 1) {
      const offset = index * 4;

      curveCompositeLut[offset] = composite[index];
      curveCompositeLut[offset + 1] = composite[index];
      curveCompositeLut[offset + 2] = composite[index];
      curveCompositeLut[offset + 3] = 255;

      curveChannelLut[offset] = red[index];
      curveChannelLut[offset + 1] = green[index];
      curveChannelLut[offset + 2] = blue[index];
      curveChannelLut[offset + 3] = 255;
    }

    curveUniforms = {
      compositeOn:
        curvesEnabled && !CURVES.isIdentityLut(composite) ? 1 : 0,
      channelsOn:
        curvesEnabled &&
        !(
          CURVES.isIdentityLut(red) &&
          CURVES.isIdentityLut(green) &&
          CURVES.isIdentityLut(blue)
        )
          ? 1
          : 0,
    };
    curveLutRevision += 1;
  }

  function curvePlot() {
    const size = curveView.size;
    const plot = Math.max(40, size - CURVE_PAD * 2);

    return { size, pad: CURVE_PAD, plot };
  }

  function curveToPixel(x, y) {
    const { pad, plot } = curvePlot();

    return { px: pad + x * plot, py: pad + (1 - y) * plot };
  }

  function pixelToCurve(px, py) {
    const { pad, plot } = curvePlot();

    return {
      x: (px - pad) / plot,
      y: 1 - (py - pad) / plot,
    };
  }

  function curveLocalPoint(event) {
    const rect = curveCanvas.getBoundingClientRect();

    // clientLeft/clientTop 是边框宽度，去掉它才能和 clientWidth 用同一套坐标
    return {
      px: event.clientX - rect.left - curveCanvas.clientLeft,
      py: event.clientY - rect.top - curveCanvas.clientTop,
    };
  }

  function resizeCurveCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(curveCanvas.clientWidth) || 300;

    curveCanvas.width = Math.max(80, Math.round(size * dpr));
    curveCanvas.height = curveCanvas.width;
    curveView = { size, dpr };
  }

  function drawCurveHistogram(context, pad, plot) {
    const values = CURVES.histogramFor(curveHistogram, curvesState.active);

    if (!values) {
      return;
    }

    const reference = CURVES.histogramScale(values);
    const channel = CURVES.CHANNELS.find(
      (item) => item.id === curvesState.active,
    );
    const isComposite = curvesState.active === "rgb";

    context.save();
    context.globalAlpha = isComposite ? 0.34 : 0.42;
    context.fillStyle = isComposite
      ? "#98a3b1"
      : (channel && channel.color) || "#98a3b1";
    context.beginPath();
    context.moveTo(pad, pad + plot);

    for (let index = 0; index < values.length; index += 1) {
      const x = pad + (index / (values.length - 1)) * plot;
      const height = Math.min(1, values[index] / reference) * plot;

      context.lineTo(x, pad + plot - height);
    }

    context.lineTo(pad + plot, pad + plot);
    context.closePath();
    context.fill();
    context.restore();
  }

  function drawCurveEditor() {
    if (!CURVES || !curvesState) {
      return;
    }

    const context = curveCanvas.getContext("2d");
    const { size, pad, plot } = curvePlot();
    const channel = CURVES.CHANNELS.find(
      (item) => item.id === curvesState.active,
    );
    const points = activeCurvePoints();

    context.setTransform(curveView.dpr, 0, 0, curveView.dpr, 0, 0);
    context.clearRect(0, 0, size, size);
    context.fillStyle = "#0b0e12";
    context.fillRect(0, 0, size, size);

    context.strokeStyle = "rgba(255, 255, 255, 0.07)";
    context.lineWidth = 1;

    for (let step = 0; step <= 4; step += 1) {
      const offset = Math.round(pad + (plot * step) / 4) + 0.5;

      context.beginPath();
      context.moveTo(offset, pad);
      context.lineTo(offset, pad + plot);
      context.moveTo(pad, offset);
      context.lineTo(pad + plot, offset);
      context.stroke();
    }

    drawCurveHistogram(context, pad, plot);

    context.save();
    context.setLineDash([4, 4]);
    context.strokeStyle = "rgba(255, 255, 255, 0.22)";
    context.beginPath();
    context.moveTo(pad, pad + plot);
    context.lineTo(pad + plot, pad);
    context.stroke();
    context.restore();

    const path = CURVES.flatten(points, 64);

    context.strokeStyle = (channel && channel.color) || "#e6ebf1";
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.beginPath();
    path.forEach((point, index) => {
      const { px, py } = curveToPixel(point.x, point.y);

      if (index === 0) {
        context.moveTo(px, py);
      } else {
        context.lineTo(px, py);
      }
    });
    context.stroke();

    const selected = points[curveSelection];

    if (selected) {
      const handles = CURVES.handlePositions(points, curveSelection);
      const anchor = curveToPixel(selected.x, selected.y);

      context.strokeStyle = "rgba(244, 183, 77, 0.8)";
      context.lineWidth = 1.5;

      for (const side of ["in", "out"]) {
        const handle = handles[side];

        if (!handle) {
          continue;
        }

        const point = curveToPixel(handle.x, handle.y);

        context.beginPath();
        context.moveTo(anchor.px, anchor.py);
        context.lineTo(point.px, point.py);
        context.stroke();

        context.beginPath();
        context.arc(point.px, point.py, 4, 0, Math.PI * 2);
        context.fillStyle = "#f4b74d";
        context.fill();
      }
    }

    points.forEach((point, index) => {
      const { px, py } = curveToPixel(point.x, point.y);
      const isSelected = index === curveSelection;

      context.beginPath();
      context.arc(px, py, isSelected ? 6 : 4.5, 0, Math.PI * 2);
      context.fillStyle = isSelected ? "#f4b74d" : "#0b0e12";
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = isSelected ? "#fff3d6" : "#e6ebf1";
      context.stroke();
    });
  }

  /** 命中测试：先看选中点的控制柄，再看所有锚点。 */
  function hitTestCurve(px, py) {
    const points = activeCurvePoints();

    if (!points) {
      return null;
    }

    const selected = points[curveSelection];

    if (selected) {
      const handles = CURVES.handlePositions(points, curveSelection);

      for (const side of ["in", "out"]) {
        const handle = handles[side];

        if (!handle) {
          continue;
        }

        const point = curveToPixel(handle.x, handle.y);

        if (Math.hypot(point.px - px, point.py - py) <= CURVE_HANDLE_HIT_RADIUS) {
          return { type: "handle", side, index: curveSelection };
        }
      }
    }

    let best = null;

    points.forEach((point, index) => {
      const pixel = curveToPixel(point.x, point.y);
      const distance = Math.hypot(pixel.px - px, pixel.py - py);

      if (distance <= CURVE_HIT_RADIUS && (!best || distance < best.distance)) {
        best = { type: "point", index, distance };
      }
    });

    return best;
  }

  function updateCurveReadout() {
    const points = activeCurvePoints();
    const point = points ? points[curveSelection] : null;

    if (!point) {
      curvePointValue.value = "未选中关键点";

      return;
    }

    curvePointValue.value = `输入 ${Math.round(point.x * 255)} → 输出 ${Math.round(
      point.y * 255,
    )}`;
  }

  /** 曲线改动后的统一收尾：重算查找表、重画、重新渲染。 */
  function applyCurveChange() {
    rebuildCurveLuts();
    renderRevision += 1;
    invalidateAiResult();
    drawCurveEditor();
    updateCurveReadout();
    updateCurveRowValue();
    schedulePreviewRender();
  }

  /** 直方图取自当前校色结果，与 Photoshop 一样随调整实时变化。 */
  function refreshCurveHistogram(force) {
    if (!CURVES || !processedCanvas.width || !processedCanvas.height) {
      return;
    }

    const now = window.performance.now();

    if (!force && now - curveHistogramAt < CURVE_HISTOGRAM_INTERVAL) {
      return;
    }

    curveHistogramAt = now;

    const scale = Math.min(
      1,
      256 / Math.max(processedCanvas.width, processedCanvas.height),
    );
    const width = Math.max(1, Math.round(processedCanvas.width * scale));
    const height = Math.max(1, Math.round(processedCanvas.height * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    canvas.width = width;
    canvas.height = height;
    context.drawImage(processedCanvas, 0, 0, width, height);
    curveHistogram = CURVES.buildHistogram(
      context.getImageData(0, 0, width, height).data,
    );
  }

  function updateCurveEditor() {
    if (!curveDialog.open) {
      return;
    }

    refreshCurveHistogram(false);
    drawCurveEditor();
  }

  function updateCurveChannelButtons() {
    for (const button of curveChannelButtons) {
      const isActive = button.dataset.channel === curvesState.active;

      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    }
  }

  function openCurveDialog() {
    if (!CURVES || !curvesState || !currentSource) {
      return;
    }

    if (!curveDialog.open) {
      curveDialog.show();
    }

    resizeCurveCanvas();
    refreshCurveHistogram(true);
    updateCurveChannelButtons();
    drawCurveEditor();
    updateCurveReadout();

    if (posterizeDialog.open) {
      positionPosterizeDialog();
    }
  }

  function closeCurveDialog() {
    if (curveDialog.open) {
      curveDialog.close();
    }
  }

  function deleteSelectedCurvePoint() {
    if (!CURVES || !curvesState || curveSelection < 0) {
      return;
    }

    const result = CURVES.removePoint(activeCurvePoints(), curveSelection);

    if (!result.removed) {
      showToast("两个端点不能删除，只能上下移动");

      return;
    }

    setActiveCurve(result.points);
    curveSelection = -1;
    applyCurveChange();
  }

  /** 双击空白处新建关键点。 */
  function insertCurvePointAt(px, py) {
    if (!CURVES || !curvesState) {
      return;
    }

    if (hitTestCurve(px, py)) {
      return;
    }

    const position = pixelToCurve(px, py);

    if (position.x < 0 || position.x > 1 || position.y < 0 || position.y > 1) {
      return;
    }

    const result = CURVES.insertPoint(
      activeCurvePoints(),
      position.x,
      position.y,
    );

    if (result.index < 0) {
      showToast(`每条曲线最多 ${CURVES.MAX_POINTS} 个关键点`);

      return;
    }

    setActiveCurve(result.points);
    curveSelection = result.index;
    applyCurveChange();
  }

  function beginCurveDrag(event) {
    if (!CURVES || !curvesState) {
      return;
    }

    const local = curveLocalPoint(event);
    const hit = hitTestCurve(local.px, local.py);

    if (!hit) {
      curveSelection = -1;
      curveDrag = null;
      drawCurveEditor();
      updateCurveReadout();

      return;
    }

    curveSelection = hit.index;
    curveDrag = hit;

    try {
      curveCanvas.setPointerCapture(event.pointerId);
    } catch {
      // 指针已经释放时 setPointerCapture 会抛错，拖动本身不受影响
    }

    event.preventDefault();
    drawCurveEditor();
    updateCurveReadout();
  }

  function continueCurveDrag(event) {
    if (!curveDrag || !CURVES || !curvesState) {
      return;
    }

    const local = curveLocalPoint(event);
    const position = pixelToCurve(local.px, local.py);
    const points = activeCurvePoints();
    const next =
      curveDrag.type === "handle"
        ? CURVES.moveHandle(
            points,
            curveDrag.index,
            curveDrag.side,
            position.x,
            position.y,
          )
        : CURVES.movePoint(points, curveDrag.index, position.x, position.y);

    setActiveCurve(next);
    applyCurveChange();
    event.preventDefault();
  }

  function endCurveDrag(event) {
    try {
      if (curveCanvas.hasPointerCapture?.(event.pointerId)) {
        curveCanvas.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 指针已经不存在时忽略
    }

    curveDrag = null;
    drawCurveEditor();
  }

  function resetActiveCurve() {
    if (!CURVES || !curvesState) {
      return;
    }

    setActiveCurve(CURVES.createIdentityPoints());
    curveSelection = -1;
    applyCurveChange();
  }

  function resetAllCurves() {
    curvesState = createDefaultCurves();
    curvesEnabled = true;
    curveSelection = -1;
    curveDrag = null;
    rebuildCurveLuts();

    if (curveDialog.open) {
      updateCurveChannelButtons();
      drawCurveEditor();
      updateCurveReadout();
    }

    updateCurveRowValue();
    syncEffectSwitches();
  }

  /* ------------------------------------------------------------------ *
   * 色调分离：弹出的分级窗口
   * ------------------------------------------------------------------ */

  function resizePosterizePreview() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(posterizePreview.clientWidth) || 304;
    const height = Math.round(posterizePreview.clientHeight) || 48;

    posterizeView = { width: Math.max(80, width), height: Math.max(24, height), dpr };
    posterizePreview.width = Math.round(posterizeView.width * dpr);
    posterizePreview.height = Math.round(posterizeView.height * dpr);
  }

  /** 画一条「输入明暗 → 输出分级」的预览条，直接看出色块有多少段。 */
  function drawPosterizePreview() {
    if (!POSTERIZE) {
      return;
    }

    const { width, height, dpr } = posterizeView;

    if (width < 2 || height < 2) {
      return;
    }

    const context = posterizePreview.getContext("2d");
    const channelMode = posterizeState.mode === "channels";
    const rows = channelMode
      ? POSTERIZE.CHANNELS.map((channel) => ({
          key: channel.id,
          enabled: Boolean(posterizeState.channels[channel.id]),
        }))
      : [{ key: "luma", enabled: true }];
    const rowHeight = height / rows.length;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    rows.forEach((row, index) => {
      for (let x = 0; x < width; x += 1) {
        context.fillStyle = POSTERIZE.previewColor(
          x / (width - 1),
          row.key,
          row.enabled,
          posterizeState.levels,
        );
        context.fillRect(x, index * rowHeight, 1, rowHeight + 1);
      }
    });
  }

  function updatePosterizeChannelButtons() {
    for (const button of posterizeChannelButtons) {
      const active = Boolean(posterizeState.channels[button.dataset.channel]);

      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }

    posterizeChannelRow.hidden = posterizeState.mode !== "channels";

    const activeCount = POSTERIZE
      ? POSTERIZE.CHANNELS.filter((channel) => posterizeState.channels[channel.id])
          .length
      : 0;

    posterizeChannelValue.value = `${activeCount}/3`;
  }

  function updatePosterizeReadout() {
    const text = POSTERIZE ? POSTERIZE.describe(posterizeState) : "色调分离模块未载入";

    posterizeSummary.value = text;
    posterizeRowValue.value = posterizeUniforms.enabled
      ? `${posterizeUniforms.levels} 级 · ${Math.round(posterizeUniforms.amount * 100)}%`
      : "关";
    syncEffectSwitches();
  }

  /** 曲线行摘要：关闭时显示「关」，否则列出被改动过的通道。 */
  function updateCurveRowValue() {
    if (!CURVES || !curvesState) {
      curveRowValue.value = "不可用";

      return;
    }

    if (!curvesEnabled) {
      curveRowValue.value = "关";

      return;
    }

    const changed = CURVES.CHANNELS.filter(
      (channel) => !CURVES.isIdentityPoints(curvesState.channels[channel.id]),
    );

    curveRowValue.value = changed.length
      ? changed.map((channel) => channel.label).join("+")
      : "未调整";
  }

  /** 同步两个「开启」勾选框。 */
  function syncEffectSwitches() {
    curvesEnabledInput.checked = curvesEnabled;
    posterizeEnabled.checked = Boolean(posterizeState.enabled);
  }

  function applyPosterizeChange() {
    refreshPosterizeUniforms();
    renderRevision += 1;
    invalidateAiResult();
    updatePosterizeChannelButtons();
    drawPosterizePreview();
    updatePosterizeReadout();
    schedulePreviewRender();
  }

  function syncPosterizeControls() {
    posterizeModeSelect.value = posterizeState.mode;
    setSliderValue("posterizeLevels", posterizeState.levels);
    setSliderValue("posterizeAmount", posterizeState.amount);
    refreshPosterizeUniforms();
    updatePosterizeChannelButtons();
    syncEffectSwitches();

    if (posterizeDialog.open) {
      resizePosterizePreview();
      drawPosterizePreview();
    }

    updatePosterizeReadout();
  }

  function updatePosterizeSetting(key, rawValue) {
    const value = Number(rawValue);

    if (key === "posterizeLevels") {
      posterizeState.levels = value;
    } else if (key === "posterizeAmount") {
      posterizeState.amount = value;
    } else {
      return;
    }

    updateControlAppearance(key);
    applyPosterizeChange();
  }

  function resetPosterize() {
    // 窗口内的重置回到「默认分离效果」，而不是把效果关掉
    posterizeState = POSTERIZE ? POSTERIZE.createActiveState() : createDefaultPosterize();
    syncPosterizeControls();
    applyPosterizeChange();
  }

  /** 曲线窗口展开时把色调分离窗口挪到它下面，避免两个窗口叠在一起。 */
  function positionPosterizeDialog() {
    const below = curveDialog.open
      ? curveDialog.getBoundingClientRect().bottom + 10
      : 76;
    const limit = Math.max(76, window.innerHeight - 280);

    posterizeDialog.style.top = `${Math.round(Math.min(Math.max(76, below), limit))}px`;
  }

  function openPosterizeDialog() {
    if (!POSTERIZE || !currentSource) {
      return;
    }

    if (!posterizeDialog.open) {
      posterizeDialog.show();
    }

    // 还没有效果时直接套用默认分级，"点一下就能看到变化"
    if (posterizeState.amount <= 0) {
      posterizeState = POSTERIZE.createActiveState();
      syncPosterizeControls();
      applyPosterizeChange();
      showToast("已按 8 级分离色阶，可拖动强度调整");
    }

    positionPosterizeDialog();
    resizePosterizePreview();
    updatePosterizeChannelButtons();
    drawPosterizePreview();
    updatePosterizeReadout();
  }

  function closePosterizeDialog() {
    if (posterizeDialog.open) {
      posterizeDialog.close();
    }
  }

  /* ------------------------------------------------------------------ *
   * 参数面板高度：拖动分隔条即可缩放，双击恢复自适应
   * ------------------------------------------------------------------ */

  const CONTROLS_MIN_HEIGHT = 132;
  const PREVIEW_MIN_HEIGHT = 160;
  const CONTROLS_STORAGE_KEY = "colorAdjustApp.controlsHeight";
  let controlsPanelHeight = readStoredControlsHeight();

  function readStoredControlsHeight() {
    try {
      const stored = Number(window.localStorage.getItem(CONTROLS_STORAGE_KEY));

      return Number.isFinite(stored) && stored > 0 ? stored : null;
    } catch {
      return null;
    }
  }

  function storeControlsHeight(value) {
    try {
      if (value === null) {
        window.localStorage.removeItem(CONTROLS_STORAGE_KEY);
      } else {
        window.localStorage.setItem(CONTROLS_STORAGE_KEY, String(Math.round(value)));
      }
    } catch {
      // 隐私模式等场景下忽略
    }
  }

  function maxControlsHeight() {
    const header = document.querySelector(".app-header");
    // 工具条占掉的高度也要算进去，否则参数面板会把画面挤没
    const barHeight =
      geometryBar && !geometryBar.hidden ? geometryBar.offsetHeight : 0;

    return Math.max(
      CONTROLS_MIN_HEIGHT,
      window.innerHeight -
        (header?.offsetHeight || 64) -
        8 -
        (PREVIEW_MIN_HEIGHT + barHeight),
    );
  }

  function clampControlsHeight(value) {
    return Math.max(
      CONTROLS_MIN_HEIGHT,
      Math.min(maxControlsHeight(), Math.round(value)),
    );
  }

  /**
   * 应用面板高度：拖动过就用固定高度，否则交给内容自适应；
   * 自适应时如果内容装不下（窗口太小），自动给一个可滚动的高度，避免被裁掉。
   */
  function updateControlsHeight() {
    if (controlsPanelHeight) {
      controlsPanelHeight = clampControlsHeight(controlsPanelHeight);
      appShell.style.setProperty("--controls-height", `${controlsPanelHeight}px`);
      // 预览区高度变了，裁切框要重新贴合画面
      positionCropOverlay();

      return;
    }

    appShell.style.setProperty("--controls-height", "auto");

    const controls = document.querySelector(".controls");
    const natural = controls ? controls.getBoundingClientRect().height : 0;

    if (natural > maxControlsHeight()) {
      appShell.style.setProperty("--controls-height", `${maxControlsHeight()}px`);
    }

    // 预览区高度变了，裁切框要重新贴合画面
    positionCropOverlay();
  }

  function setControlsHeight(value, persist = true) {
    controlsPanelHeight = value === null ? null : clampControlsHeight(value);

    if (persist) {
      storeControlsHeight(controlsPanelHeight);
    }

    updateControlsHeight();
  }

  function beginSplitterDrag(event) {
    panelSplitter.classList.add("is-dragging");

    try {
      panelSplitter.setPointerCapture(event.pointerId);
    } catch {
      // 指针已释放时忽略
    }

    event.preventDefault();
    moveSplitter(event);
  }

  function moveSplitter(event) {
    setControlsHeight(window.innerHeight - event.clientY, false);
  }

  function endSplitterDrag(event) {
    panelSplitter.classList.remove("is-dragging");

    try {
      if (panelSplitter.hasPointerCapture?.(event.pointerId)) {
        panelSplitter.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 指针已经不存在时忽略
    }

    if (controlsPanelHeight) {
      storeControlsHeight(controlsPanelHeight);
    }
  }

  function nudgeSplitter(delta) {
    setControlsHeight((controlsPanelHeight || maxControlsHeight()) + delta);
  }

  function updatePreviewVisibility() {
    const hasSource = Boolean(currentSource);

    originalCanvas.hidden = !hasSource;
    processedCanvas.hidden = !hasSource;
    aiCanvas.hidden = !hasSource || !activeAiResult;
    processedLabel.textContent = activeAiResult ? "AI 结果" : "实时校色";
  }

  function drawAiResultToPreview() {
    if (!activeAiResult || !previewSize.width || !previewSize.height) {
      return;
    }

    aiCanvas.width = previewSize.width;
    aiCanvas.height = previewSize.height;
    const context = aiCanvas.getContext("2d", { alpha: true });

    // AI 结果是整幅画面，同样按当前几何旋转裁切后再叠加
    drawGeometryView(
      context,
      activeAiResult.image,
      activeAiResult.width || frameSize.width,
      activeAiResult.height || frameSize.height,
      getRenderGeometry(),
      previewSize,
      null,
    );
  }

  function renderPreview() {
    if (!currentSource || !previewTextureSource || !previewDisplayCanvas) {
      return;
    }

    const geometry = getRenderGeometry();
    const textureWidth = previewTextureSource.width;
    const textureHeight = previewTextureSource.height;

    frameSize = { width: textureWidth, height: textureHeight };
    previewSize = computeViewSize(textureWidth, textureHeight, geometry);

    const originalContext = originalCanvas.getContext("2d", { alpha: true });

    originalCanvas.width = previewSize.width;
    originalCanvas.height = previewSize.height;
    // 原图也要跟着一起旋转裁切，左右两侧才始终对得上
    drawGeometryView(
      originalContext,
      previewDisplayCanvas,
      textureWidth,
      textureHeight,
      geometry,
      previewSize,
      null,
    );

    try {
      const renderSource = prepareRenderableSource(previewTextureSource);

      if (
        !previewRenderer ||
        previewRenderer.sourceKind !== renderSource.kind
      ) {
        destroyRenderer(previewRenderer);
        previewRenderer = createRenderer(document.createElement("canvas"), {
          preserveDrawingBuffer: true,
          sourceKind: renderSource.kind,
        });
      }

      setRendererTexture(previewRenderer, renderSource);
      renderWithRenderer(
        previewRenderer,
        previewSize.width,
        previewSize.height,
        settings,
        getWhiteBalanceResult(),
        geometry,
      );

      const glError = previewRenderer.gl.getError();

      if (glError !== previewRenderer.gl.NO_ERROR) {
        throw new Error(`WebGL 渲染失败，错误码：${glError}`);
      }

      processedCanvas.width = previewSize.width;
      processedCanvas.height = previewSize.height;
      const processedContext = processedCanvas.getContext("2d", {
        alpha: true,
      });

      processedContext.clearRect(0, 0, previewSize.width, previewSize.height);
      processedContext.drawImage(
        previewRenderer.canvas,
        0,
        0,
        previewSize.width,
        previewSize.height,
      );

      drawAiResultToPreview();
      updatePreviewVisibility();
      updateWhiteBalanceReadout();
      updateGrayPointMarker();
      updateCurveEditor();
      positionCropOverlay();
      updateGeometryReadout();
    } catch (error) {
      showToast(error.message || "无法生成预览", true);
    }
  }

  function formatValue(value, bipolar) {
    if (bipolar && value > 0) {
      return `+${value}`;
    }

    return String(value);
  }

  function updateControlAppearance(key) {
    const { input, output, row } = controls.get(key);
    const bipolar = BIPOLAR_KEYS.has(key);
    const value = Number(input.value);
    const minimum = Number(input.min);
    const maximum = Number(input.max);
    const defaultValue = CONTROL_RESET_VALUES[key] ?? 0;
    const position = ((value - minimum) / (maximum - minimum)) * 100;

    if (bipolar) {
      const start = Math.min(50, position);
      const end = Math.max(50, position);

      input.style.setProperty("--fill-start", `${start}%`);
      input.style.setProperty("--fill-end", `${end}%`);
    } else {
      input.style.setProperty("--fill-start", "0%");
      input.style.setProperty("--fill-end", `${position}%`);
    }

    input.setAttribute("aria-valuetext", describeControlValue(key, value));

    if (output) {
      output.value = formatControlValue(key, value);
    }

    row.classList.toggle("is-active", value !== defaultValue);
    syncNumberField(key);
  }

  function setSliderValue(key, value) {
    const { input } = controls.get(key);

    input.value = String(Math.round(value));
    updateControlAppearance(key);
  }

  function syncControls() {
    for (const key of CONTROL_KEYS) {
      const { input } = controls.get(key);

      input.value = String(Math.round(settings[key] * 100));
      updateControlAppearance(key);
    }

    syncWhiteBalanceControls();
    syncPosterizeControls();
  }

  function updateBeautifyStrengthAppearance() {
    const value = Number(beautifyStrength.value);

    beautifyStrength.style.setProperty("--fill-start", "0%");
    beautifyStrength.style.setProperty("--fill-end", `${value}%`);
    updateBeautifyNumberField();
  }

  function resetAdjustments() {
    settings = createDefaultSettings();
    whiteBalance = createDefaultWhiteBalance();
    invalidateWhiteBalance();
    resetAllCurves();
    posterizeState = createDefaultPosterize();
    geometryState = createDefaultGeometry();
    cropMode = false;
    cropBackup = null;
    cropDrag = null;
    cropAspect = "free";

    if (cropAspectSelect) {
      cropAspectSelect.value = "free";
    }

    renderRevision += 1;
    invalidateAiResult();
    syncControls();
    updateCropControls();
    applyGeometryChange();
  }

  function updateSetting(key, rawValue) {
    settings[key] = Number(rawValue) / 100;
    renderRevision += 1;
    invalidateAiResult();
    updateControlAppearance(key);
    schedulePreviewRender();
  }

  /** 滑条输入按所属模块分发。 */
  function applySliderValue(key, rawValue) {
    const { input } = controls.get(key);
    const clamped = Math.max(
      Number(input.min),
      Math.min(Number(input.max), Number(rawValue)),
    );

    input.value = String(clamped);

    if (WB_SLIDER_KEYS.includes(key)) {
      updateWhiteBalanceSetting(key, clamped);
    } else if (POSTERIZE_SLIDER_KEYS.includes(key)) {
      updatePosterizeSetting(key, clamped);
    } else {
      updateSetting(key, clamped);
    }
  }

  function releaseSource() {
    if (sourceUrl) {
      URL.revokeObjectURL(sourceUrl);
    }

    sourceUrl = "";
    currentSource = null;
    sourceFile = null;
    previewTextureSource = null;
    previewDisplayCanvas = null;
    previewSize = { width: 0, height: 0 };
    frameSize = { width: 0, height: 0 };
    cropMode = false;
    cropBackup = null;
    cropDrag = null;
    destroyRenderer(previewRenderer);
    previewRenderer = null;
    analysisCache = { revision: -1, buffer: null };
    updateGrayPointMarker();
  }

  function setImageReady(isReady) {
    const canUseImage = isReady && !imageLoadInProgress;

    dropLayer.hidden = isReady;
    controlsFieldset.disabled = !canUseImage;
    resetButton.disabled = !canUseImage;
    curveButton.disabled = !canUseImage || !CURVES;
    posterizeButton.disabled = !canUseImage || !POSTERIZE;
    exportButton.disabled = !canUseImage || exportInProgress;

    if (!isReady) {
      cropMode = false;
      cropBackup = null;
      cropDrag = null;
    }

    syncGeometryControls();
    updateCropControls();
    updateGeometryReadout();
    updatePreviewVisibility();
    updateWhiteBalanceRowVisibility();
    updateAiControls();
    updateControlsHeight();
  }

  function blobToImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取这张图片"));
      image.src = url;
    });
  }

  function getFileExtension(fileNameValue) {
    const match = /\.([^.\\/]+)$/.exec(fileNameValue || "");
    return match ? match[1].toLowerCase() : "";
  }

  function isRawFile(file) {
    return Boolean(file) && RAW_EXTENSIONS.has(getFileExtension(file.name));
  }

  function isSupportedImageFile(file) {
    return Boolean(file) && (file.type.startsWith("image/") || isRawFile(file));
  }

  async function assertRecognizableRawFile(file) {
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());

    if (header.length < 4) {
      throw new Error("文件内容为空或格式不完整");
    }

    const ascii = String.fromCharCode(...header);
    const isLittleTiff =
      header[0] === 0x49 && header[1] === 0x49 && header[2] === 42;
    const isBigTiff =
      header[0] === 0x4d && header[1] === 0x4d && header[3] === 42;
    const hasKnownSignature =
      isLittleTiff ||
      isBigTiff ||
      ascii.startsWith("FUJIFILMCCD-RAW") ||
      ascii.startsWith("FOVb") ||
      ascii.startsWith("IIII") ||
      ascii.startsWith("\0MRM") ||
      ascii.startsWith("IIRO") ||
      ascii.startsWith("MMOR") ||
      ascii.startsWith("IIU\0") ||
      (ascii.slice(4, 8) === "ftyp" && ascii.slice(8, 12).startsWith("crx"));

    if (!hasKnownSignature) {
      throw new Error("文件头不像受支持的 RAW 格式");
    }
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer = 0;
    const timeout = new Promise((resolve, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
      window.clearTimeout(timer);
    });
  }

  async function getLibRawConstructor() {
    if (!libRawModulePromise) {
      libRawModulePromise = import(LIBRAW_MODULE_URL)
        .then((module) => module.default)
        .catch((error) => {
          libRawModulePromise = null;
          throw error;
        });
    }

    return libRawModulePromise;
  }

  async function decodeRawFile(file) {
    if (window.location.protocol === "file:") {
      throw new Error("请通过 start.cmd 启动后解码 RAW 图片");
    }

    if (!window.crossOriginIsolated) {
      throw new Error("RAW 解码环境未就绪，请关闭页面后重新运行 start.cmd");
    }

    await assertRecognizableRawFile(file);
    const LibRaw = await getLibRawConstructor();
    const decoder = new LibRaw();

    activeRawDecoder = decoder;

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const rawImage = await withTimeout(
        (async () => {
          await decoder.open(bytes, RAW_DECODE_SETTINGS);
          return decoder.imageData();
        })(),
        RAW_DECODE_TIMEOUT,
        "RAW 解码超时或文件不受支持",
      );

      return rawImageDataToU16Source(rawImage);
    } finally {
      if (activeRawDecoder === decoder) {
        activeRawDecoder = null;
      }

      decoder.dispose();
    }
  }

  function setImageLoading(isLoading, file) {
    imageLoadInProgress = isLoading;
    previewStage.classList.toggle("is-loading", isLoading);
    previewStage.setAttribute("aria-busy", String(isLoading));
    dropLayer.disabled = isLoading;

    if (isLoading) {
      controlsFieldset.disabled = true;
      resetButton.disabled = true;
      exportButton.disabled = true;
      fileName.textContent = `${isRawFile(file) ? "正在解码 RAW" : "正在载入"}：${file.name}`;
      return;
    }

    fileName.textContent = sourceFile?.name || "未载入图片";
    setImageReady(Boolean(currentSource));
  }

  async function loadImageFile(file) {
    if (!isSupportedImageFile(file)) {
      showToast("请拖入支持的图片或 RAW 文件", true);
      return;
    }

    const requestId = ++loadRequestId;
    const isRaw = isRawFile(file);
    let nextUrl = "";
    let retainedUrl = false;

    if (activeRawDecoder) {
      activeRawDecoder.dispose();
      activeRawDecoder = null;
    }

    invalidateAiResult();
    setImageLoading(true, file);
    showToast(isRaw ? "正在解码 RAW（16 位高质量）..." : "正在载入图片...");

    try {
      let nextSource;

      if (isRaw) {
        nextSource = await decodeRawFile(file);
      } else {
        nextUrl = URL.createObjectURL(file);
        const image = await blobToImage(nextUrl);
        const dimensions = {
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
        };

        nextSource = {
          kind: "image",
          width: dimensions.width,
          height: dimensions.height,
          image,
        };
      }

      if (requestId !== loadRequestId) {
        return;
      }

      const nextPreview = createPreviewState(nextSource);

      releaseSource();
      currentSource = nextSource;
      sourceFile = file;
      sourceUrl = nextUrl;
      retainedUrl = Boolean(nextUrl);
      sourceRevision += 1;
      renderRevision += 1;
      previewTextureSource = nextPreview.textureSource;
      previewDisplayCanvas = nextPreview.displayCanvas;
      frameSize = nextPreview.size;
      previewSize = computeViewSize(
        nextPreview.size.width,
        nextPreview.size.height,
        null,
      );
      geometryState = createDefaultGeometry();
      cropMode = false;
      cropBackup = null;
      cropDrag = null;
      cropAspect = "free";
      settings = createDefaultSettings();
      whiteBalance = createDefaultWhiteBalance();
      invalidateWhiteBalance();
      resetAllCurves();
      posterizeState = createDefaultPosterize();
      analysisCache = { revision: -1, buffer: null };
      curveHistogram = null;
      lastAiOutput = null;
      syncControls();
      fileName.textContent = file.name;
      setImageReady(true);
      renderPreview();

      if (isRaw && !supportsWebGL2()) {
        showToast("已解码 RAW；当前浏览器无 WebGL2，已使用 8 位兼容模式");
      } else {
        showToast(
          isRaw ? `已解码 16 位 RAW：${file.name}` : `已载入：${file.name}`,
        );
      }
    } catch (error) {
      if (requestId === loadRequestId) {
        const message = error?.message || "图片载入失败";

        showToast(
          isRaw && !message.startsWith("RAW") && !message.startsWith("请")
            ? `RAW 解码失败：${message}`
            : message,
          true,
        );
      }
    } finally {
      if (nextUrl && !retainedUrl) {
        URL.revokeObjectURL(nextUrl);
      }

      if (requestId === loadRequestId) {
        setImageLoading(false);
      }
    }
  }

  function getDropImageFile(dataTransfer) {
    if (!dataTransfer) {
      return null;
    }

    return Array.from(dataTransfer.files || []).find(isSupportedImageFile);
  }

  function hasDraggedFiles(event) {
    const types = event.dataTransfer?.types;

    if (!types) {
      return false;
    }

    return Array.from(types).includes("Files");
  }

  function setDragging(isDragging) {
    previewStage.classList.toggle("is-dragging", isDragging);
  }

  function showToast(message, isError = false) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("is-error", isError);
    toast.classList.add("is-visible");

    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2400);
  }

  function outputDetails() {
    const inputType = sourceFile?.type || "image/png";

    if (isRawFile(sourceFile)) {
      return { mimeType: "image/png", extension: "png", quality: undefined };
    }

    if (inputType === "image/jpeg") {
      return { mimeType: "image/jpeg", extension: "jpg", quality: JPEG_QUALITY };
    }

    if (inputType === "image/webp") {
      return {
        mimeType: "image/webp",
        extension: "webp",
        quality: JPEG_QUALITY,
      };
    }

    return { mimeType: "image/png", extension: "png", quality: undefined };
  }

  function downloadBlob(blob, fileNameValue) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileNameValue;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getOutputFileName(extension) {
    const originalName = sourceFile?.name || "image";
    const baseName = originalName.replace(/\.[^.]+$/, "") || "image";

    return `${baseName}-校色.${extension}`;
  }

  function getAiOutputFileName() {
    const originalName = sourceFile?.name || "image";
    const baseName = originalName.replace(/\.[^.]+$/, "") || "image";

    return `${baseName}-AI.png`;
  }

  function getMaxTextureSize(sourceKind) {
    if (previewRenderer?.gl) {
      return previewRenderer.gl.getParameter(
        previewRenderer.gl.MAX_TEXTURE_SIZE,
      );
    }

    const canvas = document.createElement("canvas");
    const renderer = createRenderer(canvas, {
      preserveDrawingBuffer: false,
      sourceKind,
    });
    const maxTextureSize = renderer.gl.getParameter(
      renderer.gl.MAX_TEXTURE_SIZE,
    );

    destroyRenderer(renderer);
    return maxTextureSize;
  }

  /**
   * 按当前校色参数渲染整幅原图。
   * options.geometry 传 null 表示忽略旋转裁切（AI 输入用的就是整幅原图）；
   * options.matte 是导出格式不支持透明时的垫底色（JPEG 用白色）。
   */
  async function renderSourceToCanvas(source, options = {}) {
    const geometry =
      options.geometry === undefined ? getRenderGeometry() : options.geometry;
    const matte = options.matte || "";
    const renderSource = prepareRenderableSource(source);
    const dimensions = getSourceDimensions(renderSource);
    const maxTextureSize = getMaxTextureSize(renderSource.kind) || 4096;
    // 旋转会把画面撑大，纹理尺寸要按旋转后的外接矩形来限制，
    // 否则大图拉直后导出画布会超出显卡与浏览器的画布上限
    const angle = GEO ? GEO.totalAngle(geometry) : 0;
    const bounds = GEO
      ? GEO.rotatedBounds(dimensions.width, dimensions.height, angle)
      : dimensions;
    const longestEdge = Math.max(bounds.width, bounds.height, 1);
    const exportScale = Math.min(1, maxTextureSize / longestEdge);
    // 纹理尺寸受显卡限制，输出尺寸再由几何决定
    const textureWidth = Math.max(1, Math.round(dimensions.width * exportScale));
    const textureHeight = Math.max(
      1,
      Math.round(dimensions.height * exportScale),
    );
    const textureSource = createScaledRenderSource(
      renderSource,
      textureWidth,
      textureHeight,
    );
    const view = computeViewSize(textureWidth, textureHeight, geometry);
    const renderCanvas = document.createElement("canvas");
    const renderer = createRenderer(renderCanvas, {
      preserveDrawingBuffer: false,
      sourceKind: textureSource.kind,
    });

    try {
      setRendererTexture(renderer, textureSource);
      renderWithRenderer(
        renderer,
        view.width,
        view.height,
        settings,
        undefined,
        geometry,
      );

      const flattenedCanvas = document.createElement("canvas");
      const flattenedContext = flattenedCanvas.getContext("2d", {
        alpha: true,
      });

      flattenedCanvas.width = view.width;
      flattenedCanvas.height = view.height;
      flattenedContext.drawImage(renderCanvas, 0, 0);

      if (matte) {
        // 旋转留下的空白角在 JPEG 里会变成黑块，垫一层底色更符合直觉
        flattenedContext.globalCompositeOperation = "destination-over";
        flattenedContext.fillStyle = matte;
        flattenedContext.fillRect(0, 0, view.width, view.height);
        flattenedContext.globalCompositeOperation = "source-over";
      }

      return {
        canvas: flattenedCanvas,
        width: view.width,
        height: view.height,
        scaled: exportScale < 1,
      };
    } finally {
      destroyRenderer(renderer);
    }
  }

  async function renderSourceToBlob(mimeType, quality, options) {
    const rendered = await renderSourceToCanvas(currentSource, options);
    const blob = await canvasToBlob(rendered.canvas, mimeType, quality);

    return { ...rendered, blob };
  }

  async function exportAdjustedImage() {
    if (!currentSource || exportInProgress || imageLoadInProgress) {
      return;
    }

    exportInProgress = true;
    exportButton.disabled = true;
    exportButton.textContent = "导出中...";

    try {
      const output = outputDetails();
      // 保留透明的格式直接导出，JPEG 之类先垫白底
      const matte = output.mimeType === "image/jpeg" ? "#ffffff" : "";
      const geometry = getRenderGeometry();
      let blob;
      let width;
      let height;
      let scaled = false;

      if (activeAiResult) {
        const view = computeViewSize(
          activeAiResult.width || frameSize.width,
          activeAiResult.height || frameSize.height,
          geometry,
        );

        width = view.width;
        height = view.height;

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { alpha: true });

        canvas.width = width;
        canvas.height = height;
        drawGeometryView(
          context,
          activeAiResult.image,
          activeAiResult.width || frameSize.width,
          activeAiResult.height || frameSize.height,
          geometry,
          view,
          matte,
        );
        blob = await canvasToBlob(canvas, output.mimeType, output.quality);
      } else {
        const rendered = await renderSourceToBlob(
          output.mimeType,
          output.quality,
          { matte },
        );

        blob = rendered.blob;
        width = rendered.width;
        height = rendered.height;
        scaled = rendered.scaled;
      }

      downloadBlob(blob, getOutputFileName(output.extension));

      if (scaled) {
        showToast(`图片过大，已按 ${width} × ${height} 导出`);
      } else {
        showToast(`已导出 ${width} × ${height} 图片`);
      }
    } catch (error) {
      showToast(error.message || "导出失败", true);
    } finally {
      exportInProgress = false;
      exportButton.disabled = !currentSource || imageLoadInProgress;
      exportButton.textContent = "导出图片";
    }
  }

  function setAiStatus(message, state = "") {
    aiStatus.textContent = message;
    aiStatus.title = "";
    aiStatus.classList.toggle("is-running", state === "running");
    aiStatus.classList.toggle("is-success", state === "success");
    aiStatus.classList.toggle("is-error", state === "error");
  }

  function populateModels(models, preferredModel = "") {
    const uniqueModels = Array.from(new Set(models || [])).sort((left, right) =>
      left.localeCompare(right),
    );
    const previous = preferredModel || modelSelect.value;

    modelSelect.replaceChildren();

    if (uniqueModels.length === 0) {
      const option = document.createElement("option");

      option.value = "";
      option.textContent = "未找到模型";
      modelSelect.append(option);
    } else {
      for (const model of uniqueModels) {
        const option = document.createElement("option");

        option.value = model;
        option.textContent = model;
        modelSelect.append(option);
      }

      if (uniqueModels.includes(previous)) {
        modelSelect.value = previous;
      }
    }

    comfyStatus.models = uniqueModels;
    updateAiControls();
  }

  function updateAiControls() {
    const running = Boolean(aiJob);
    const hasImage = Boolean(currentSource);
    const hasModel = Boolean(modelSelect.value);
    const dependencyState = getAiDependencyState();
    const savedOutput = activeAiResult?.savedPath
      ? {
          savedPath: activeAiResult.savedPath,
          resultUrl: activeAiResult.resultUrl,
        }
      : lastAiOutput;
    const canStart =
      hasImage &&
      hasModel &&
      comfyStatus.available &&
      comfyStatus.valid &&
      dependencyState.ready &&
      comfyStatus.models.length > 0 &&
      !exportInProgress;

    modelSelect.disabled = running || comfyStatus.models.length === 0;
    refreshModelsButton.disabled = running;
    beautifyStrength.disabled = running;
    comfySettingsButton.disabled = running;
    beautifyButton.disabled = running ? false : !canStart;
    openAiResultButton.hidden = !savedOutput?.resultUrl;
    openAiResultButton.disabled = running || !savedOutput?.resultUrl;
    revealAiResultButton.hidden = !savedOutput?.savedPath;
    revealAiResultButton.disabled = running || !savedOutput?.savedPath;
    beautifyButton.querySelector("span").textContent = running
      ? "取消"
      : "AI 美化";

    if (running) {
      return;
    }

    if (!comfyStatus.available) {
      setAiStatus("请通过 start.cmd 启动本地服务", "error");
    } else if (!comfyStatus.valid) {
      setAiStatus("需要设置 ComfyUI 安装目录", "error");
    } else if (!dependencyState.ready) {
      setAiStatus(
        `缺少 AI 依赖：${dependencyState.missing.join("、")}`,
        "error",
      );
    } else if (!hasImage) {
      setAiStatus("载入图片后可执行人像美化");
    } else if (!hasModel) {
      setAiStatus("未找到可用的人像模型", "error");
    } else if (!activeAiResult && savedOutput?.savedPath) {
      setAiStatus(`上次结果已保存：${savedOutput.savedPath}`, "success");
      aiStatus.title = savedOutput.savedPath;
    } else if (comfyStatus.online) {
      setAiStatus("ComfyUI 已连接，可执行人像美化", "success");
    } else {
      setAiStatus("开始处理时会自动启动 ComfyUI");
    }
  }

  function getAiDependencyState() {
    const nodes = comfyStatus.nodes || {};
    const missing = [];

    if (!nodes.impactPack) {
      missing.push("Impact Pack");
    }

    if (!nodes.impactSubpack) {
      missing.push("Impact Subpack");
    }

    if (!nodes.faceDetector) {
      missing.push("人脸检测模型");
    }

    if (!nodes.sam) {
      missing.push("SAM 模型");
    }

    return { ready: missing.length === 0, missing };
  }

  function describeAiError(message) {
    const text = String(message || "").trim();

    if (!text) {
      return "AI 人像美化失败";
    }

    if (AI_ERROR_MESSAGES.has(text)) {
      return AI_ERROR_MESSAGES.get(text);
    }

    const startupFailure = /^ComfyUI exited during startup\.?\s*([\s\S]*)$/.exec(
      text,
    );

    if (startupFailure) {
      const detail = startupFailure[1].trim().split(/\r?\n/)[0].slice(0, 160);

      return detail
        ? `ComfyUI 启动过程中退出：${detail}`
        : "ComfyUI 启动过程中退出";
    }

    if (/[\u4e00-\u9fff]/.test(text)) {
      return text;
    }

    return `AI 处理失败：${text}`;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
    });

    if (!response.ok) {
      let message = `请求失败（${response.status}）`;

      try {
        const body = await response.json();

        if (body?.error) {
          message = body.error;
        }
      } catch {
        // Keep the HTTP status fallback.
      }

      throw new Error(message);
    }

    return response.json();
  }

  function applyComfyStatus(status) {
    comfyStatus = {
      ...comfyStatus,
      ...status,
      models: status.models || comfyStatus.models || [],
    };

    if (Array.isArray(status.models)) {
      populateModels(comfyStatus.models, status.model || modelSelect.value);
    }

    updateAiControls();
  }

  async function refreshComfyStatus(options = {}) {
    const requestId = ++comfyStatusRequest;

    try {
      const status = await requestJson("/api/comfy/status");

      if (requestId !== comfyStatusRequest) {
        return null;
      }

      applyComfyStatus({ ...status, available: true });
      return status;
    } catch (error) {
      if (requestId !== comfyStatusRequest) {
        return null;
      }

      comfyStatus.available = false;
      comfyStatus.error = error.message;
      updateAiControls();

      if (!options.silent) {
        showToast(error.message || "无法连接本地桥接服务", true);
      }

      return null;
    }
  }

  async function refreshModels() {
    if (!comfyStatus.valid) {
      await refreshComfyStatus({ silent: true });
    }

    if (!comfyStatus.valid) {
      return;
    }

    try {
      setAiStatus("正在刷新模型列表...", "running");
      const response = await requestJson("/api/comfy/models");

      populateModels(response.models || [], response.model || "");

      if (comfyStatus.online) {
        setAiStatus("ComfyUI 已连接，可执行人像美化", "success");
      } else {
        setAiStatus("开始处理时会自动启动 ComfyUI");
      }
    } catch (error) {
      setAiStatus(describeAiError(error.message || "模型列表读取失败"), "error");
    }
  }

  function clearAiJobTimer() {
    if (aiJob?.pollTimer) {
      window.clearTimeout(aiJob.pollTimer);
    }
  }

  function releaseAiResult() {
    if (!activeAiResult) {
      return;
    }

    URL.revokeObjectURL(activeAiResult.url);
    activeAiResult = null;
    aiCanvas.hidden = true;
  }

  function invalidateAiResult() {
    const runningJob = aiJob;

    releaseAiResult();

    if (runningJob) {
      clearAiJobTimer();
      aiJob = null;
      aiJobToken += 1;

      if (runningJob.id) {
        fetch(`/api/comfy/jobs/${runningJob.id}`, {
          method: "DELETE",
          cache: "no-store",
        }).catch(() => {});
      }
    }

    updatePreviewVisibility();
    updateAiControls();
  }

  async function cancelAiJob() {
    if (!aiJob) {
      return;
    }

    const jobId = aiJob.id;

    clearAiJobTimer();
    aiJob = null;
    aiJobToken += 1;
    setAiStatus("正在取消...", "running");

    try {
      if (jobId) {
        await fetch(`/api/comfy/jobs/${jobId}`, {
          method: "DELETE",
          cache: "no-store",
        });
      }
    } catch (error) {
      showToast(error.message || "取消失败", true);
    }

    updateAiControls();
    setAiStatus("已取消");
  }

  async function activateAiResult(blob, job) {
    const url = URL.createObjectURL(blob);

    try {
      const image = await blobToImage(url);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;

      if (
        job.sourceRevision !== sourceRevision ||
        job.renderRevision !== renderRevision
      ) {
        URL.revokeObjectURL(url);
        return false;
      }

      releaseAiResult();
      activeAiResult = {
        blob,
        url,
        image,
        width,
        height,
        jobId: job.id,
        savedPath: job.savedPath || "",
        resultUrl: job.resultUrl || "",
      };

      if (activeAiResult.savedPath) {
        lastAiOutput = {
          savedPath: activeAiResult.savedPath,
          resultUrl: activeAiResult.resultUrl,
        };
      }

      drawAiResultToPreview();
      updatePreviewVisibility();
      updateAiControls();
      return true;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  async function pollAiJob(jobId, token) {
    if (!aiJob || aiJob.id !== jobId || aiJobToken !== token) {
      return;
    }

    try {
      const state = await requestJson(`/api/comfy/jobs/${jobId}`);

      if (!aiJob || aiJob.id !== jobId || aiJobToken !== token) {
        return;
      }

      aiJob.state = state.state;
      aiJob.progress = Number(state.progress) || 0;
      aiJob.savedPath = state.savedPath || aiJob.savedPath || "";
      aiJob.resultUrl = state.resultUrl || aiJob.resultUrl || "";

      if (state.state === "succeeded") {
        setAiStatus("正在载入美化结果...", "running");

        const response = await fetch(`/api/comfy/jobs/${jobId}/result`, {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`AI 结果下载失败（${response.status}）`);
        }

        const blob = await response.blob();
        const activated = await activateAiResult(blob, aiJob);
        const completedJobId = aiJob.id;

        clearAiJobTimer();
        aiJob = null;
        aiJobToken += 1;

        if (activated) {
          showToast(
            activeAiResult?.savedPath
              ? "AI 人像美化完成，结果已保存到 outputs 文件夹"
              : "AI 人像美化完成",
          );
        } else {
          showToast("参数已变化，旧 AI 结果已丢弃");
        }

        fetch(`/api/comfy/jobs/${completedJobId}`, {
          method: "DELETE",
          cache: "no-store",
        }).catch(() => {});
        updateAiControls();

        if (activated) {
          setAiStatus(
            activeAiResult?.savedPath
              ? `已保存：${activeAiResult.savedPath}`
              : "人像美化完成",
            "success",
          );
          aiStatus.title = activeAiResult?.savedPath || "";
        } else {
          setAiStatus("参数已变化，旧结果已丢弃");
        }
        return;
      }

      if (state.state === "no_face") {
        clearAiJobTimer();
        aiJob = null;
        aiJobToken += 1;
        showToast("未检测到人脸，未执行生成式美化");
        updateAiControls();
        setAiStatus("未检测到人脸，图片保持不变");
        return;
      }

      if (state.state === "failed" || state.state === "cancelled") {
        const message =
          state.state === "cancelled"
            ? "任务已取消"
            : describeAiError(state.error);

        clearAiJobTimer();
        aiJob = null;
        aiJobToken += 1;
        updateAiControls();
        setAiStatus(message, state.state === "failed" ? "error" : "");
        return;
      }

      const progress = Math.max(0, Math.min(99, Number(state.progress) || 0));

      setAiStatus(
        state.state === "queued"
          ? `等待 ComfyUI 队列 ${progress}%`
          : `人像美化处理中 ${progress}%`,
        "running",
      );
      aiJob.pollTimer = window.setTimeout(
        () => pollAiJob(jobId, token),
        AI_POLL_INTERVAL,
      );
    } catch (error) {
      if (!aiJob || aiJob.id !== jobId || aiJobToken !== token) {
        return;
      }

      clearAiJobTimer();
      aiJob.pollTimer = window.setTimeout(
        () => pollAiJob(jobId, token),
        AI_POLL_INTERVAL,
      );
      setAiStatus(error.message || "等待 ComfyUI 结果...", "running");
    }
  }

  async function startAiBeautify() {
    if (!currentSource || imageLoadInProgress) {
      return;
    }

    const strength = Number(beautifyStrength.value) / 100;

    if (strength <= 0.0001) {
      setAiStatus("磨皮为 0，没有需要生成的人像效果");
      return;
    }

    if (!modelSelect.value) {
      setAiStatus("请先选择人像模型", "error");
      return;
    }

    const token = ++aiJobToken;
    const job = {
      id: "",
      state: "uploading",
      progress: 0,
      pollTimer: 0,
      sourceRevision,
      renderRevision,
    };

    aiJob = job;
    updateAiControls();
    setAiStatus("正在生成原分辨率 AI 输入...", "running");

    try {
      // AI 输入始终是未旋转裁切的整幅画面，几何变换在显示 / 导出时再套用
      const rendered = await renderSourceToCanvas(currentSource, {
        geometry: null,
      });

      if (
        !aiJob ||
        aiJobToken !== token ||
        job.sourceRevision !== sourceRevision ||
        job.renderRevision !== renderRevision
      ) {
        return;
      }

      const blob = await canvasToBlob(rendered.canvas, "image/png");
      const headers = {
        "Content-Type": "image/png",
        "X-ColorAdjust-Model": encodeURIComponent(modelSelect.value),
        "X-ColorAdjust-Beautify": String(strength),
        "X-ColorAdjust-Detail": String(settings.detail),
        "X-ColorAdjust-Output-Name": encodeURIComponent(
          getAiOutputFileName(),
        ),
      };
      const response = await fetch("/api/comfy/jobs", {
        method: "POST",
        cache: "no-store",
        headers,
        body: blob,
      });

      if (!response.ok) {
        let message = "无法提交人像美化任务";

        try {
          const body = await response.json();

          message = body?.error || message;
        } catch {
          // Use fallback message.
        }

        throw new Error(message);
      }

      const body = await response.json();

      if (!body?.id) {
        throw new Error("桥接服务没有返回任务编号");
      }

      if (
        aiJobToken !== token ||
        aiJob !== job ||
        job.sourceRevision !== sourceRevision ||
        job.renderRevision !== renderRevision
      ) {
        fetch(`/api/comfy/jobs/${body.id}`, {
          method: "DELETE",
          cache: "no-store",
        }).catch(() => {});
        return;
      }

      job.id = body.id;
      job.state = body.state || "queued";
      job.progress = Number(body.progress) || 10;
      setAiStatus("正在启动或连接 ComfyUI...", "running");
      updateAiControls();
      pollAiJob(job.id, token);
    } catch (error) {
      if (aiJobToken === token) {
        clearAiJobTimer();
        aiJob = null;
        aiJobToken += 1;
        updateAiControls();
        setAiStatus(describeAiError(error.message), "error");
      }
    }
  }

  function openComfyDialog() {
    comfyRootInput.value = comfyStatus.root || "";
    comfyPortInput.value = String(comfyStatus.port || 8188);
    comfyConfigMessage.textContent = "";
    comfyConfigMessage.classList.remove("is-error");
    comfyDialog.showModal();
  }

  function closeComfyDialog() {
    comfyDialog.close();
  }

  async function saveComfyConfig(event) {
    event.preventDefault();
    const root = comfyRootInput.value.trim();
    const port = Number(comfyPortInput.value);

    if (!root) {
      comfyConfigMessage.textContent = "请输入 ComfyUI 安装目录";
      comfyConfigMessage.classList.add("is-error");
      return;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      comfyConfigMessage.textContent = "端口必须是 1 到 65535 之间的整数";
      comfyConfigMessage.classList.add("is-error");
      return;
    }

    saveComfyConfigButton.disabled = true;
    comfyConfigMessage.textContent = "正在检测...";
    comfyConfigMessage.classList.remove("is-error");

    try {
      const status = await requestJson("/api/comfy/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, port }),
      });

      applyComfyStatus({ ...status, available: true });
      comfyConfigMessage.textContent = status.online
        ? "检测通过，ComfyUI 已连接"
        : "检测通过，任务开始时会启动 ComfyUI";
      await refreshModels();
      closeComfyDialog();
    } catch (error) {
      comfyConfigMessage.textContent = describeAiError(
        error.message || "配置检测失败",
      );
      comfyConfigMessage.classList.add("is-error");
    } finally {
      saveComfyConfigButton.disabled = false;
    }
  }

  for (const key of SLIDER_KEYS) {
    const { input, row, number } = controls.get(key);

    configureNumberField(key);

    input.addEventListener("input", (event) => {
      applySliderValue(key, event.currentTarget.value);
    });

    row.addEventListener("dblclick", (event) => {
      if (event.target === number) {
        return;
      }

      const defaultValue = CONTROL_RESET_VALUES[key] ?? 0;

      input.value = String(defaultValue);
      applySliderValue(key, defaultValue);
    });

    if (number) {
      number.addEventListener("input", () => applyNumberField(key));
      number.addEventListener("change", () => commitNumberField(key));
      number.addEventListener("blur", () => commitNumberField(key));
      number.addEventListener("focus", () => number.select());
      number.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitNumberField(key);
        }
      });
    }
  }

  /* 磨皮滑条同样支持直接输入数值 */
  function updateBeautifyNumberField() {
    if (document.activeElement === beautifyStrengthNumber) {
      return;
    }

    beautifyStrengthNumber.value = String(Math.round(Number(beautifyStrength.value)));
  }

  if (beautifyStrengthNumber) {
    beautifyStrengthNumber.min = beautifyStrength.min;
    beautifyStrengthNumber.max = beautifyStrength.max;
    beautifyStrengthNumber.step = "1";
    beautifyStrengthNumber.addEventListener("input", () => {
      const value = Number(beautifyStrengthNumber.value);

      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return;
      }

      beautifyStrength.value = String(Math.round(value));
      renderRevision += 1;
      invalidateAiResult();
      updateBeautifyStrengthAppearance();
    });
    beautifyStrengthNumber.addEventListener("blur", () => {
      const clamped = Math.max(
        0,
        Math.min(100, Math.round(Number(beautifyStrengthNumber.value) || 0)),
      );

      beautifyStrength.value = String(clamped);
      updateBeautifyStrengthAppearance();
    });
    beautifyStrengthNumber.addEventListener("focus", () =>
      beautifyStrengthNumber.select(),
    );
  }

  /* ---- 画面几何：在图片框上直接旋转 / 翻转 / 裁切 ---- */

  function commitRotationAngle() {
    if (!rotationAngleNumber) {
      return;
    }

    const value = Number(rotationAngleNumber.value);

    if (!Number.isFinite(value)) {
      rotationAngleNumber.value = GEO
        ? GEO.formatAngle(geometryState.angle)
        : String(geometryState.angle);

      return;
    }

    setGeometryAngle(value);
    rotationAngleNumber.value = GEO
      ? GEO.formatAngle(geometryState.angle)
      : String(geometryState.angle);
  }

  rotateLeftButton.addEventListener("click", () => rotateGeometry(-1));
  rotateRightButton.addEventListener("click", () => rotateGeometry(1));
  flipHorizontalButton.addEventListener("click", () => flipGeometry("h"));
  flipVerticalButton.addEventListener("click", () => flipGeometry("v"));
  resetGeometryButton.addEventListener("click", resetGeometry);
  rotationAngle.addEventListener("input", () =>
    setGeometryAngle(rotationAngle.value),
  );
  rotationAngle.addEventListener("dblclick", () => setGeometryAngle(0));

  if (rotationAngleNumber) {
    rotationAngleNumber.min = String(-(GEO ? GEO.MAX_FINE_ANGLE : 45));
    rotationAngleNumber.max = String(GEO ? GEO.MAX_FINE_ANGLE : 45);
    rotationAngleNumber.step = "0.1";
    rotationAngleNumber.addEventListener("input", () => {
      const value = Number(rotationAngleNumber.value);
      const limit = GEO ? GEO.MAX_FINE_ANGLE : 45;

      if (!Number.isFinite(value) || Math.abs(value) > limit) {
        return;
      }

      geometryState = { ...geometryState, angle: value };
      applyGeometryChange();
    });
    rotationAngleNumber.addEventListener("change", commitRotationAngle);
    rotationAngleNumber.addEventListener("blur", commitRotationAngle);
    rotationAngleNumber.addEventListener("focus", () =>
      rotationAngleNumber.select(),
    );
  }

  cropButton.addEventListener("click", () => setCropMode(!cropMode));
  cropAspectSelect.addEventListener("change", () =>
    applyCropAspect(cropAspectSelect.value),
  );
  cropAutoButton.addEventListener("click", applyAutoCrop);
  cropApplyButton.addEventListener("click", applyCropEdit);
  cropCancelButton.addEventListener("click", cancelCropEdit);
  cropOverlay.addEventListener("pointerdown", beginCropDrag);
  cropOverlay.addEventListener("pointermove", continueCropDrag);
  cropOverlay.addEventListener("pointerup", endCropDrag);
  cropOverlay.addEventListener("pointercancel", endCropDrag);

  window.addEventListener("keydown", (event) => {
    if (!cropMode) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelCropEdit();

      return;
    }

    const tag = document.activeElement?.tagName;

    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      applyCropEdit();

      return;
    }

    const step = event.shiftKey ? 0.01 : 0.002;
    const moves = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];

    if (move) {
      event.preventDefault();
      nudgeCrop(move[0], move[1]);
    }
  });

  panelSplitter.addEventListener("pointerdown", beginSplitterDrag);
  panelSplitter.addEventListener("pointermove", (event) => {
    if (panelSplitter.classList.contains("is-dragging")) {
      moveSplitter(event);
    }
  });
  panelSplitter.addEventListener("pointerup", endSplitterDrag);
  panelSplitter.addEventListener("pointercancel", endSplitterDrag);
  panelSplitter.addEventListener("dblclick", () => setControlsHeight(null));
  panelSplitter.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      nudgeSplitter(24);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      nudgeSplitter(-24);
    } else if (event.key === "Home") {
      event.preventDefault();
      setControlsHeight(null);
    }
  });

  for (const canvas of [originalCanvas, processedCanvas]) {
    canvas.addEventListener("click", pickGrayPoint);
  }

  whiteBalanceModeSelect.addEventListener("change", (event) => {
    applyWhiteBalanceMode(event.currentTarget.value);
  });
  wbPresetSelect.addEventListener("change", (event) => {
    applyWhiteBalancePreset(event.currentTarget.value);
  });
  wbAlgorithmSelect.addEventListener("change", (event) => {
    whiteBalance.algorithm = event.currentTarget.value;
    invalidateWhiteBalance();
    renderRevision += 1;
    invalidateAiResult();
    updateWhiteBalanceReadout();
    schedulePreviewRender();
  });
  window.addEventListener("resize", updateGrayPointMarker);
  window.addEventListener("resize", () => {
    updateControlsHeight();
    positionCropOverlay();

    if (curveDialog.open) {
      resizeCurveCanvas();
      drawCurveEditor();
    }

    if (posterizeDialog.open) {
      positionPosterizeDialog();
      resizePosterizePreview();
      drawPosterizePreview();
    }
  });

  curveButton.addEventListener("click", () => {
    if (curveDialog.open) {
      closeCurveDialog();
    } else {
      openCurveDialog();
    }
  });
  closeCurveDialogButton.addEventListener("click", closeCurveDialog);
  resetCurveButton.addEventListener("click", resetActiveCurve);
  curveCanvas.addEventListener("pointerdown", beginCurveDrag);
  curveCanvas.addEventListener("pointermove", continueCurveDrag);
  curveCanvas.addEventListener("pointerup", endCurveDrag);
  curveCanvas.addEventListener("pointercancel", endCurveDrag);
  curveCanvas.addEventListener("dblclick", (event) => {
    const local = curveLocalPoint(event);

    insertCurvePointAt(local.px, local.py);
  });

  posterizeButton.addEventListener("click", () => {
    if (posterizeDialog.open) {
      closePosterizeDialog();
    } else {
      openPosterizeDialog();
    }
  });
  posterizeEnabled.addEventListener("change", () => {
    posterizeState.enabled = posterizeEnabled.checked;
    applyPosterizeChange();
  });
  curvesEnabledInput.addEventListener("change", () => {
    curvesEnabled = curvesEnabledInput.checked;
    applyCurveChange();
  });
  closePosterizeDialogButton.addEventListener("click", closePosterizeDialog);
  resetPosterizeButton.addEventListener("click", resetPosterize);
  posterizeModeSelect.addEventListener("change", (event) => {
    posterizeState.mode = event.currentTarget.value;
    applyPosterizeChange();
    schedulePreviewRender();
  });

  for (const button of posterizeChannelButtons) {
    button.addEventListener("click", () => {
      const channel = button.dataset.channel;

      posterizeState.channels[channel] = !posterizeState.channels[channel];
      applyPosterizeChange();
    });
  }

  for (const button of curveChannelButtons) {
    button.addEventListener("click", () => {
      if (!curvesState) {
        return;
      }

      curvesState.active = button.dataset.channel;
      curveSelection = -1;
      updateCurveChannelButtons();
      drawCurveEditor();
      updateCurveReadout();
    });
  }

  window.addEventListener("keydown", (event) => {
    if (!curveDialog.open && !posterizeDialog.open) {
      return;
    }

    if (event.key === "Escape") {
      closeCurveDialog();
      closePosterizeDialog();

      return;
    }

    if (curveDialog.open && (event.key === "Delete" || event.key === "Backspace")) {
      if (curveSelection < 0) {
        return;
      }

      event.preventDefault();
      deleteSelectedCurvePoint();
    }
  });

  resetButton.addEventListener("click", resetAdjustments);
  exportButton.addEventListener("click", exportAdjustedImage);
  dropLayer.addEventListener("click", () => fileInput.click());
  beautifyStrength.addEventListener("input", () => {
    renderRevision += 1;
    invalidateAiResult();
    updateBeautifyStrengthAppearance();
  });
  beautifyButton.addEventListener("click", () => {
    if (aiJob) {
      cancelAiJob();
    } else {
      startAiBeautify();
    }
  });
  openAiResultButton.addEventListener("click", () => {
    const resultUrl = activeAiResult?.resultUrl || lastAiOutput?.resultUrl;

    if (resultUrl) {
      window.open(resultUrl, "_blank", "noopener");
    }
  });
  revealAiResultButton.addEventListener("click", async () => {
    const savedPath = activeAiResult?.savedPath || lastAiOutput?.savedPath;

    if (!savedPath) {
      return;
    }

    try {
      await requestJson("/api/outputs/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: savedPath }),
      });
    } catch (error) {
      showToast(error.message || "无法打开输出文件夹", true);
    }
  });
  refreshModelsButton.addEventListener("click", refreshModels);
  comfySettingsButton.addEventListener("click", openComfyDialog);
  closeComfyDialogButton.addEventListener("click", closeComfyDialog);
  cancelComfyDialogButton.addEventListener("click", closeComfyDialog);
  comfyForm.addEventListener("submit", saveComfyConfig);
  modelSelect.addEventListener("change", () => {
    renderRevision += 1;
    invalidateAiResult();
  });

  fileInput.addEventListener("change", () => {
    const [file] = fileInput.files || [];

    if (file) {
      loadImageFile(file);
    }

    fileInput.value = "";
  });

  window.addEventListener("dragenter", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });

  window.addEventListener("dragover", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    dragDepth = Math.max(0, dragDepth - 1);

    if (dragDepth === 0) {
      setDragging(false);
    }
  });

  window.addEventListener("drop", (event) => {
    if (!hasDraggedFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepth = 0;
    setDragging(false);

    const imageFile = getDropImageFile(event.dataTransfer);

    if (imageFile) {
      loadImageFile(imageFile);
    } else {
      showToast("请拖入图片文件", true);
    }
  });

  window.addEventListener("paste", (event) => {
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) =>
      item.type.startsWith("image/"),
    );
    const imageFile = imageItem?.getAsFile();

    if (imageFile) {
      loadImageFile(imageFile);
    }
  });

  window.addEventListener("keydown", (event) => {
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key.toLowerCase() === "o") {
      event.preventDefault();
      fileInput.click();
    }

    if (
      modifier &&
      event.key.toLowerCase() === "s" &&
      currentSource &&
      !imageLoadInProgress
    ) {
      event.preventDefault();
      exportAdjustedImage();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (sourceUrl) {
      URL.revokeObjectURL(sourceUrl);
    }

    releaseAiResult();

    if (aiJob?.id) {
      fetch(`/api/comfy/jobs/${aiJob.id}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    }
  });

  if (!WB) {
    // 色彩模块不可用时只保留旧版手动双轴，白平衡相关控件全部禁用
    for (const key of WB_SELECT_KEYS) {
      document.querySelector(`#${key}`).disabled = true;
    }
  }

  if (CURVES) {
    rebuildCurveLuts();
    resizeCurveCanvas();
    updateCurveChannelButtons();
  } else {
    curveButton.disabled = true;
  }

  if (POSTERIZE) {
    resizePosterizePreview();
  } else {
    posterizeButton.disabled = true;
  }

  updateCurveRowValue();
  updateControlsHeight();
  syncControls();
  updateBeautifyStrengthAppearance();
  updateAiControls();
  setImageReady(false);
  refreshComfyStatus({ silent: true }).then(refreshModels);
})();
