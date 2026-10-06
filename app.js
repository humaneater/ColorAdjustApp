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
  ];
  const FILTER_CONTROL_KEYS = ["denoise", "detail"];
  const CONTROL_KEYS = [...COLOR_CONTROL_KEYS, ...FILTER_CONTROL_KEYS];
  const BIPOLAR_KEYS = new Set(COLOR_CONTROL_KEYS);
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
  const toast = document.querySelector("#toast");
  const modelSelect = document.querySelector("#modelSelect");
  const refreshModelsButton = document.querySelector("#refreshModelsButton");
  const beautifyStrength = document.querySelector("#beautifyStrength");
  const beautifyStrengthValue = document.querySelector(
    "#beautifyStrengthValue",
  );
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
    CONTROL_KEYS.map((key) => [
      key,
      {
        input: document.querySelector(`#${key}`),
        output: document.querySelector(`#${key}Value`),
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
  let settings = createDefaultSettings();
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
      centerTexel = `
        ivec2 size = textureSize(u_image, 0);
        return ivec2(
          clamp(int(gl_FragCoord.x), 0, size.x - 1),
          clamp(size.y - 1 - int(gl_FragCoord.y), 0, size.y - 1)
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
        return ivec2(
          clamp(int(gl_FragCoord.x), 0, size.x - 1),
          clamp(int(gl_FragCoord.y), 0, size.y - 1)
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
      centerTexel = `
        return ivec2(
          clamp(int(gl_FragCoord.x), 0, int(u_textureSize.x) - 1),
          clamp(int(gl_FragCoord.y), 0, int(u_textureSize.y) - 1)
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
    uniform float u_saturation;
    uniform float u_hueShift;
    uniform float u_vibrance;
    uniform float u_brightness;
    uniform float u_exposure;
    uniform float u_contrast;
    uniform float u_temperature;
    uniform float u_whiteBalance;
    uniform float u_shadows;
    uniform float u_denoise;
    uniform float u_detail;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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

    vec3 adjustColor(vec3 color) {
      color *= exp2(u_exposure * 1.5);
      color += u_brightness * 0.32;

      color.r += u_temperature * 0.14 * (1.0 - color.r);
      color.b -= u_temperature * 0.14 * color.b;

      color.r += u_whiteBalance * 0.1 * (1.0 - color.r);
      color.b += u_whiteBalance * 0.1 * (1.0 - color.b);
      color.g -= u_whiteBalance * 0.16 * color.g;

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

      return clamp(color, 0.0, 1.0);
    }

    void main() {
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

  function createRenderer(canvas, options = {}) {
    const preserveDrawingBuffer = Boolean(options.preserveDrawingBuffer);
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
    };

    for (const key of CONTROL_KEYS) {
      uniforms[key] = gl.getUniformLocation(program, `u_${key}`);
    }

    gl.useProgram(program);
    gl.uniform1i(uniforms.image, 0);
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

    gl.deleteProgram(renderer.program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
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

  function renderWithRenderer(renderer, width, height, currentSettings) {
    const { canvas, gl, program, uniforms } = renderer;

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

    for (const key of CONTROL_KEYS) {
      gl.uniform1f(uniforms[key], currentSettings[key]);
    }

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

    context.clearRect(0, 0, previewSize.width, previewSize.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      activeAiResult.image,
      0,
      0,
      previewSize.width,
      previewSize.height,
    );
  }

  function renderPreview() {
    if (!currentSource || !previewTextureSource || !previewDisplayCanvas) {
      return;
    }

    originalCanvas.width = previewSize.width;
    originalCanvas.height = previewSize.height;

    const originalContext = originalCanvas.getContext("2d", { alpha: true });

    originalContext.clearRect(0, 0, previewSize.width, previewSize.height);
    originalContext.drawImage(previewDisplayCanvas, 0, 0);

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
    const defaultValue = 0;
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

    if (bipolar) {
      input.setAttribute(
        "aria-valuetext",
        `${value > 0 ? "增加" : value < 0 ? "降低" : "无调整"} ${Math.abs(value)}`,
      );
    } else {
      input.setAttribute("aria-valuetext", String(value));
    }

    output.value = formatValue(value, bipolar);
    row.classList.toggle("is-active", value !== defaultValue);
  }

  function syncControls() {
    for (const key of CONTROL_KEYS) {
      const { input } = controls.get(key);

      input.value = String(Math.round(settings[key] * 100));
      updateControlAppearance(key);
    }
  }

  function updateBeautifyStrengthAppearance() {
    const value = Number(beautifyStrength.value);

    beautifyStrength.style.setProperty("--fill-start", "0%");
    beautifyStrength.style.setProperty("--fill-end", `${value}%`);
    beautifyStrengthValue.value = String(value);
  }

  function resetAdjustments() {
    settings = createDefaultSettings();
    renderRevision += 1;
    invalidateAiResult();
    syncControls();
    schedulePreviewRender();
  }

  function updateSetting(key, rawValue) {
    settings[key] = Number(rawValue) / 100;
    renderRevision += 1;
    invalidateAiResult();
    updateControlAppearance(key);
    schedulePreviewRender();
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
    destroyRenderer(previewRenderer);
    previewRenderer = null;
  }

  function setImageReady(isReady) {
    const canUseImage = isReady && !imageLoadInProgress;

    dropLayer.hidden = isReady;
    controlsFieldset.disabled = !canUseImage;
    resetButton.disabled = !canUseImage;
    exportButton.disabled = !canUseImage || exportInProgress;
    updatePreviewVisibility();
    updateAiControls();
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
      previewSize = nextPreview.size;
      settings = createDefaultSettings();
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

  async function renderSourceToCanvas(source) {
    const renderSource = prepareRenderableSource(source);
    const dimensions = getSourceDimensions(renderSource);
    const maxTextureSize = getMaxTextureSize(renderSource.kind) || 4096;
    const longestEdge = Math.max(dimensions.width, dimensions.height);
    const exportScale = Math.min(1, maxTextureSize / longestEdge);
    const width = Math.max(1, Math.round(dimensions.width * exportScale));
    const height = Math.max(1, Math.round(dimensions.height * exportScale));
    const textureSource = createScaledRenderSource(
      renderSource,
      width,
      height,
    );
    const renderCanvas = document.createElement("canvas");
    const renderer = createRenderer(renderCanvas, {
      preserveDrawingBuffer: false,
      sourceKind: textureSource.kind,
    });

    try {
      setRendererTexture(renderer, textureSource);
      renderWithRenderer(renderer, width, height, settings);

      const flattenedCanvas = document.createElement("canvas");
      const flattenedContext = flattenedCanvas.getContext("2d", {
        alpha: true,
      });

      flattenedCanvas.width = width;
      flattenedCanvas.height = height;
      flattenedContext.drawImage(renderCanvas, 0, 0);

      return {
        canvas: flattenedCanvas,
        width,
        height,
        scaled: exportScale < 1,
      };
    } finally {
      destroyRenderer(renderer);
    }
  }

  async function renderSourceToBlob(mimeType, quality) {
    const rendered = await renderSourceToCanvas(currentSource);
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
      let blob;
      let width;
      let height;
      let scaled = false;

      if (activeAiResult) {
        width = activeAiResult.width;
        height = activeAiResult.height;

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { alpha: true });

        canvas.width = width;
        canvas.height = height;
        context.drawImage(activeAiResult.image, 0, 0);
        blob = await canvasToBlob(canvas, output.mimeType, output.quality);
      } else {
        const rendered = await renderSourceToBlob(
          output.mimeType,
          output.quality,
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
      const rendered = await renderSourceToCanvas(currentSource);

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

  for (const key of CONTROL_KEYS) {
    const { input, row } = controls.get(key);

    input.addEventListener("input", (event) => {
      updateSetting(key, event.currentTarget.value);
    });

    row.addEventListener("dblclick", () => {
      const defaultValue = 0;

      input.value = String(defaultValue);
      updateSetting(key, defaultValue);
    });
  }

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

  syncControls();
  updateBeautifyStrengthAppearance();
  updateAiControls();
  setImageReady(false);
  refreshComfyStatus({ silent: true }).then(refreshModels);
})();
