import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "..");
const webDirectory = path.join(repositoryDirectory, "apps", "web");
const environmentPath = path.join(repositoryDirectory, ".env.local");
const webEnvironmentPath = path.join(webDirectory, ".env.local");
const logPath = path.join(repositoryDirectory, "local-setup.log");
const csrfToken = randomBytes(24).toString("hex");
const skipBrowserOpen =
  process.argv.includes("--no-open") || process.env.COMMUTE_SETUP_NO_OPEN === "1";

const nodeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVersion.split(".").map(Number);
const nodeSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);

const requiredEnvironmentNames = [
  "NEXT_PUBLIC_AMAP_JS_KEY",
  "NEXT_PUBLIC_AMAP_JS_SECURITY_CODE",
  "AMAP_WEB_SERVICE_KEY",
];
const environmentInputNames = {
  NEXT_PUBLIC_AMAP_JS_KEY: "jsKey",
  NEXT_PUBLIC_AMAP_JS_SECURITY_CODE: "securityCode",
  AMAP_WEB_SERVICE_KEY: "webServiceKey",
  AMAP_API_BASE_URL: "apiBaseUrl",
  AMAP_DEFAULT_CITY_CODE: "cityCode",
  AMAP_DEFAULT_ADCODE: "adcode",
};

let environmentState = await inspectEnvironment();
let environmentConfigured = environmentState.complete;
let devProcess = null;
let startupTimer = null;
let setupOrigin = "";
let lastCommandOutput = "";
let setupStatus = {
  phase: "ready",
  message: environmentState.message,
  appUrl: null,
  details: null,
};

try {
  writeFileSync(logPath, `[${new Date().toISOString()}] 通勤圈本地初始化助手启动\n`, "utf8");
} catch {}

function parseEnvironment(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const declaration = line.replace(/^export\s+/, "");
    const separator = declaration.indexOf("=");
    if (separator < 1) continue;
    const name = declaration.slice(0, separator).trim();
    let value = declaration.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }
  return values;
}

async function inspectEnvironment() {
  const values = new Map();
  const sources = new Map();
  const detectedFiles = [];
  const candidates = [
    { filePath: environmentPath, label: "项目根目录 .env.local" },
    { filePath: webEnvironmentPath, label: "apps/web/.env.local" },
  ];

  for (const candidate of candidates) {
    try {
      const fileValues = parseEnvironment(await readFile(candidate.filePath, "utf8"));
      detectedFiles.push(candidate.label);
      for (const [name, value] of fileValues) {
        if (!values.has(name) && value) {
          values.set(name, value);
          sources.set(name, candidate.label);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const complete = requiredEnvironmentNames.every((name) => Boolean(values.get(name)));
  const detectedCount = requiredEnvironmentNames.filter((name) => Boolean(values.get(name))).length;
  const webOnly =
    complete &&
    requiredEnvironmentNames.some((name) => sources.get(name) === "apps/web/.env.local");
  let message = "请填写高德配置。";
  if (complete && webOnly) {
    message = "已识别 apps/web/.env.local；启动时会安全合并到项目根目录。";
  } else if (complete) {
    message = "已识别项目根目录的 .env.local，可以直接启动。";
  } else if (detectedCount > 0) {
    message = `已识别 ${detectedCount}/3 项必要配置，请补齐标记为“待填写”的项目。`;
  } else if (detectedFiles.length > 0) {
    message = "找到了 .env.local，但未识别到所需的高德配置项。";
  }

  return { values, sources, detectedFiles, complete, message };
}

function cleanValue(value, required = false) {
  if (typeof value !== "string") return required ? null : "";
  const cleaned = value.trim();
  if (cleaned.includes("\n") || cleaned.includes("\r")) return null;
  if (required && !cleaned) return null;
  return cleaned;
}

async function saveEnvironment(input) {
  const current = await inspectEnvironment();
  const resolved = {};
  for (const [environmentName, inputName] of Object.entries(environmentInputNames)) {
    const provided = cleanValue(input?.[inputName]);
    if (provided === null) throw new Error("配置内容不能包含换行。");
    resolved[environmentName] = provided || current.values.get(environmentName) || "";
  }

  const jsKey = resolved.NEXT_PUBLIC_AMAP_JS_KEY;
  const securityCode = resolved.NEXT_PUBLIC_AMAP_JS_SECURITY_CODE;
  const webServiceKey = resolved.AMAP_WEB_SERVICE_KEY;
  const apiBaseUrl = resolved.AMAP_API_BASE_URL || "https://restapi.amap.com";
  const cityCode = resolved.AMAP_DEFAULT_CITY_CODE;
  const adcode = resolved.AMAP_DEFAULT_ADCODE;

  if (!jsKey || !securityCode || !webServiceKey || !apiBaseUrl) {
    throw new Error("请完整填写三项高德密钥配置。");
  }

  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error("Web 服务地址格式不正确。");
  }
  if (parsedBaseUrl.protocol !== "https:") {
    throw new Error("Web 服务地址必须使用 HTTPS。");
  }

  const contents = [
    "# 高德 JS API（浏览器端可见，请设置域名白名单）",
    `NEXT_PUBLIC_AMAP_JS_KEY=${jsKey}`,
    `NEXT_PUBLIC_AMAP_JS_SECURITY_CODE=${securityCode}`,
    "",
    "# 高德 Web 服务 API（仅服务端使用）",
    `AMAP_WEB_SERVICE_KEY=${webServiceKey}`,
    `AMAP_API_BASE_URL=${apiBaseUrl}`,
    "",
    "# 默认业务区域（可选）",
    `AMAP_DEFAULT_CITY_CODE=${cityCode ?? ""}`,
    `AMAP_DEFAULT_ADCODE=${adcode ?? ""}`,
    "",
  ].join("\n");

  await writeFile(environmentPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  environmentState = await inspectEnvironment();
  environmentConfigured = environmentState.complete;
}

function commandForNpm(arguments_) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      arguments: ["/d", "/s", "/c", "npm", ...arguments_],
    };
  }
  return { command: "npm", arguments: arguments_ };
}

function runNpm(arguments_, onOutput) {
  const npm = commandForNpm(arguments_);
  const child = spawn(npm.command, npm.arguments, {
    cwd: webDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const handleOutput = (chunk) => {
    const output = chunk.toString();
    process.stdout.write(output);
    const cleanOutput = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
    lastCommandOutput = `${lastCommandOutput}${cleanOutput}`.slice(-6000);
    try {
      appendFileSync(logPath, cleanOutput, "utf8");
    } catch {}
    onOutput?.(cleanOutput);
  };
  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);
  return child;
}

function waitForCommand(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`命令执行失败，退出码 ${code ?? "未知"}`));
    });
  });
}

async function startApplication() {
  if (!nodeSupported) {
    setupStatus = {
      phase: "error",
      message: `当前 Node.js ${nodeVersion} 版本过低，请升级到 22.13 或更高版本。`,
      appUrl: null,
      details: null,
    };
    return;
  }

  lastCommandOutput = "";
  try {
    appendFileSync(logPath, `\n[${new Date().toISOString()}] 开始启动\n`, "utf8");
  } catch {}

  try {
    const vinextBinary = path.join(
      webDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "vinext.cmd" : "vinext",
    );
    if (!existsSync(vinextBinary)) {
      setupStatus = {
        phase: "installing",
        message: "正在安装项目依赖，第一次可能需要几分钟…",
        appUrl: null,
        details: null,
      };
      await waitForCommand(runNpm(["install"]));
    }
    launchDevelopmentServer(false);
  } catch (error) {
    setupStatus = {
      phase: "error",
      message: `初始化失败：${error instanceof Error ? error.message : "未知错误"}`,
      appUrl: null,
      details: lastCommandOutput || null,
    };
  }
}

function launchDevelopmentServer(repairAttempted) {
  setupStatus = {
    phase: "starting",
    message: repairAttempted ? "依赖修复完成，正在重新启动通勤圈…" : "配置已保存，正在启动通勤圈…",
    appUrl: null,
    details: null,
  };

  let reachedRunningState = false;
  let existingServerDetected = false;
  let detectedAppUrl = null;
  let launchOutput = "";
  const launchedProcess = runNpm(["run", "dev"], (output) => {
    launchOutput = `${launchOutput}${output}`.slice(-6000);
    existingServerDetected = /Another vinext dev server is already running/i.test(launchOutput);
    const match = launchOutput.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/);
    if (!match || reachedRunningState) return;
    reachedRunningState = true;
    detectedAppUrl = match[0];
    if (startupTimer) clearTimeout(startupTimer);
    setupStatus = {
      phase: "running",
      message: existingServerDetected
        ? "检测到通勤圈已经在运行，可以直接打开。"
        : "通勤圈已成功启动。",
      appUrl: detectedAppUrl,
      details: null,
    };
  });
  devProcess = launchedProcess;

  launchedProcess.once("error", (error) => {
    if (startupTimer) clearTimeout(startupTimer);
    if (devProcess === launchedProcess) devProcess = null;
    setupStatus = {
      phase: "error",
      message: `无法启动本地服务：${error.message}`,
      appUrl: null,
      details: lastCommandOutput || null,
    };
  });
  launchedProcess.once("exit", (code) => {
    if (startupTimer) clearTimeout(startupTimer);
    if (devProcess === launchedProcess) devProcess = null;

    if (existingServerDetected && reachedRunningState && detectedAppUrl) {
      setupStatus = {
        phase: "running",
        message: "检测到通勤圈已经在运行，可以直接打开。",
        appUrl: detectedAppUrl,
        details: null,
      };
      return;
    }

    if (!reachedRunningState && code !== 0 && !repairAttempted) {
      setupStatus = {
        phase: "installing",
        message: "首次启动失败，正在自动修复依赖并重试…",
        appUrl: null,
        details: null,
      };
      void repairDependenciesAndRetry();
      return;
    }

    setupStatus = {
      phase: "error",
      message: reachedRunningState
        ? `应用已停止，退出码 ${code ?? "未知"}。`
        : `自动修复后仍无法启动，退出码 ${code ?? "未知"}。`,
      appUrl: null,
      details: lastCommandOutput || "没有捕获到启动日志。",
    };
  });

  startupTimer = setTimeout(() => {
    if (setupStatus.phase === "starting") {
      setupStatus = {
        phase: "error",
        message: "启动等待超时，请展开错误详情。",
        appUrl: null,
        details: lastCommandOutput || "没有捕获到启动日志。",
      };
    }
  }, 90_000);
}

async function repairDependenciesAndRetry() {
  try {
    await waitForCommand(runNpm(["install"]));
    launchDevelopmentServer(true);
  } catch (error) {
    setupStatus = {
      phase: "error",
      message: `依赖修复失败：${error instanceof Error ? error.message : "未知错误"}`,
      appUrl: null,
      details: lastCommandOutput || "没有捕获到安装日志。",
    };
  }
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("请求内容格式不正确。"));
      }
    });
    request.on("error", reject);
  });
}

function renderPage() {
  const fieldState = (environmentName) => {
    const detected = Boolean(environmentState.values.get(environmentName));
    return {
      badge: `<span class="field-state ${detected ? "is-detected" : ""}">${detected ? "已识别" : "待填写"}</span>`,
      attributes: detected ? 'placeholder="已从 .env.local 识别，留空即可保留"' : "required",
    };
  };
  const jsKeyState = fieldState("NEXT_PUBLIC_AMAP_JS_KEY");
  const securityCodeState = fieldState("NEXT_PUBLIC_AMAP_JS_SECURITY_CODE");
  const webServiceKeyState = fieldState("AMAP_WEB_SERVICE_KEY");
  const nodeStateClass = nodeSupported ? "is-complete" : "is-error";
  const nodeStateText = nodeSupported
    ? `Node.js ${nodeVersion} 已就绪`
    : `Node.js ${nodeVersion} 需要升级`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>通勤圈 · 本地初始化</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "Microsoft YaHei", system-ui, sans-serif; color: #20332c; background: #edf2ef; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 82% 12%, rgba(35, 112, 86, .13), transparent 32%), linear-gradient(135deg, #edf3ef, #f8f9f7 55%, #e8efeb); }
    button, input { font: inherit; }
    .shell { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0; }
    .brand { display: flex; align-items: center; gap: 11px; margin-bottom: 24px; }
    .brand-mark { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 12px; background: #173f34; color: #fff; font-weight: 800; }
    .brand strong, .brand small { display: block; }
    .brand small { margin-top: 2px; color: #76827d; font-size: 12px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr); overflow: hidden; border: 1px solid #d6e0db; border-radius: 24px; background: #fff; box-shadow: 0 28px 80px rgba(23, 50, 41, .14); }
    main { padding: 38px 42px; }
    aside { display: flex; flex-direction: column; background: #173f34; padding: 40px 32px; color: #fff; }
    .eyebrow { color: #db5b48; font-size: 12px; font-weight: 800; letter-spacing: .12em; }
    h1 { margin: 9px 0 8px; font-size: clamp(30px, 4vw, 42px); line-height: 1.13; letter-spacing: -.04em; }
    .lead { margin: 0; color: #687670; font-size: 15px; line-height: 1.7; }
    .checks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 28px 0 25px; padding: 0; list-style: none; }
    .checks li { border-bottom: 2px solid #dfe6e2; padding: 0 0 10px; color: #7c8883; font-size: 12px; font-weight: 700; }
    .checks li::before { content: "✓"; display: inline-grid; width: 22px; height: 22px; place-items: center; margin-right: 6px; border-radius: 7px; background: #e5f1eb; color: #267158; }
    .checks li.is-error::before { content: "!"; background: #fff0ed; color: #d44936; }
    fieldset { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; border: 0; margin: 0; padding: 0; }
    label { display: grid; gap: 7px; color: #405049; font-size: 13px; font-weight: 750; }
    .label-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .field-state { border-radius: 999px; background: #fff0ed; padding: 3px 8px; color: #b24a3b; font-size: 10px; font-weight: 800; }
    .field-state.is-detected { background: #e4f2eb; color: #1c684f; }
    label.full { grid-column: 1 / -1; }
    input { width: 100%; height: 42px; border: 1px solid #ced9d4; border-radius: 10px; background: #fafcfb; padding: 0 12px; color: #20332c; outline: none; }
    input:focus { border-color: #2a755d; box-shadow: 0 0 0 3px rgba(42, 117, 93, .12); }
    .hint { color: #84908b; font-size: 11px; font-weight: 500; }
    .actions { display: flex; align-items: center; gap: 10px; margin-top: 24px; }
    .primary, .secondary { min-height: 44px; border-radius: 11px; padding: 0 17px; cursor: pointer; font-weight: 800; }
    .primary { border: 0; background: #e8533f; color: #fff; box-shadow: 0 9px 22px rgba(232, 83, 63, .2); }
    .secondary { border: 1px solid #cad8d2; background: #f4f8f6; color: #315b4c; }
    button:disabled { cursor: wait; opacity: .55; }
    .status { margin-top: 16px; border-radius: 11px; background: #f0f5f2; padding: 11px 13px; color: #426055; font-size: 13px; line-height: 1.5; }
    .status.is-error { background: #fff0ed; color: #a63d2f; }
    .status.is-running { background: #e4f2eb; color: #1c684f; }
    .app-link { display: none; margin-top: 10px; color: #1c684f; font-weight: 800; }
    .app-link.is-visible { display: inline-flex; }
    .diagnostics { margin-top: 14px; border: 1px solid #ead4cf; border-radius: 11px; background: #fff8f6; padding: 10px 12px; }
    .diagnostics[hidden] { display: none; }
    .diagnostics summary { color: #943d30; }
    .diagnostics pre { max-height: 220px; overflow: auto; margin: 10px 0; border-radius: 8px; background: #1e2925; padding: 12px; color: #dce9e3; font: 12px/1.55 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
    .copy-log { border: 1px solid #d9bdb7; border-radius: 8px; background: #fff; padding: 7px 10px; color: #84382d; cursor: pointer; font-size: 12px; font-weight: 700; }
    aside h2 { margin: 10px 0 22px; font-size: 24px; }
    aside ol { display: grid; gap: 17px; margin: 0; padding-left: 20px; color: rgba(255,255,255,.76); font-size: 14px; line-height: 1.6; }
    .privacy { margin-top: auto; border-radius: 14px; background: rgba(255,255,255,.08); padding: 16px; color: rgba(255,255,255,.7); font-size: 12px; line-height: 1.65; }
    .privacy strong { display: block; margin-bottom: 4px; color: #fff; font-size: 13px; }
    details { margin-top: 18px; }
    summary { color: #4e645b; cursor: pointer; font-size: 13px; font-weight: 700; }
    details p { color: #75827d; font-size: 12px; line-height: 1.65; }
    @media (max-width: 760px) { .shell { width: min(100% - 20px, 620px); padding: 18px 0; } .layout { grid-template-columns: 1fr; border-radius: 18px; } main, aside { padding: 28px 22px; } aside { min-height: 310px; } .privacy { margin-top: 26px; } }
    @media (max-width: 460px) { fieldset { grid-template-columns: 1fr; } label.full { grid-column: auto; } .checks { grid-template-columns: 1fr; } .actions { align-items: stretch; flex-direction: column; } .actions button { width: 100%; } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="brand"><span class="brand-mark">◎</span><span><strong>通勤圈</strong><small>本地初始化助手</small></span></div>
    <div class="layout">
      <main>
        <span class="eyebrow">LOCAL SETUP</span>
        <h1>在这台电脑启动通勤圈</h1>
        <p class="lead">填写一次高德配置，剩下的依赖安装和应用启动由初始化助手完成。</p>
        <ol class="checks">
          <li>代码已下载</li>
          <li class="${nodeStateClass}">${nodeStateText}</li>
          <li>自动安装并启动</li>
        </ol>
        <form id="setup-form">
          <fieldset>
            <label class="full"><span class="label-title">高德 JS API Key ${jsKeyState.badge}</span><input name="jsKey" autocomplete="off" ${jsKeyState.attributes}><span class="hint">用于浏览器地图显示，请允许 localhost。</span></label>
            <label class="full"><span class="label-title">JS API 安全密钥 ${securityCodeState.badge}</span><input name="securityCode" type="password" autocomplete="new-password" ${securityCodeState.attributes}></label>
            <label class="full"><span class="label-title">Web 服务 API Key ${webServiceKeyState.badge}</span><input name="webServiceKey" type="password" autocomplete="new-password" ${webServiceKeyState.attributes}><span class="hint">仅写入本机服务端配置。</span></label>
            <label>默认城市代码（可选）<input name="cityCode" placeholder="例如 027"></label>
            <label>默认行政区代码（可选）<input name="adcode" placeholder="例如 420100"></label>
            <label class="full">Web 服务地址<input name="apiBaseUrl" value="https://restapi.amap.com" required></label>
          </fieldset>
          <div class="actions">
            <button class="primary" type="submit" ${nodeSupported ? "" : "disabled"}>保存配置并启动</button>
            <button class="secondary" id="reuse-button" type="button" ${environmentConfigured && nodeSupported ? "" : "hidden"}>使用已有配置启动</button>
          </div>
        </form>
        <div id="status" class="status" role="status" aria-live="polite">${setupStatus.message}</div>
        <a id="app-link" class="app-link" href="#">打开通勤圈 →</a>
        <details id="diagnostics-panel" class="diagnostics" hidden open><summary>启动错误详情</summary><pre id="diagnostics-text"></pre><button id="copy-log" class="copy-log" type="button">复制错误信息</button></details>
        <details><summary>还没有高德 Key？</summary><p>请先在高德开放平台创建 JS API Key 和 Web 服务 API Key。浏览器 Key 与服务端 Key 用途不同，不建议混用。</p></details>
      </main>
      <aside>
        <span class="eyebrow">完成后</span>
        <h2>直接进入通勤初始化</h2>
        <ol>
          <li>设置工作地点、通勤预算和出发时间。</li>
          <li>搜索附近站点并选择允许乘坐的线路。</li>
          <li>计算住所到公司的可达路线。</li>
        </ol>
        <div class="privacy"><strong>密钥只保存在本机</strong>.env.local 已被 Git 忽略；初始化助手只监听 127.0.0.1，不会把密钥上传到通勤圈线上站点。</div>
      </aside>
    </div>
  </div>
  <script>
    const token = ${JSON.stringify(csrfToken)};
    const form = document.querySelector('#setup-form');
    const reuseButton = document.querySelector('#reuse-button');
    const statusBox = document.querySelector('#status');
    const appLink = document.querySelector('#app-link');
    const diagnosticsPanel = document.querySelector('#diagnostics-panel');
    const diagnosticsText = document.querySelector('#diagnostics-text');
    const copyLogButton = document.querySelector('#copy-log');
    const buttons = [...document.querySelectorAll('button')];

    function setBusy(busy) { buttons.forEach((button) => { button.disabled = busy; }); }
    function showStatus(status) {
      statusBox.textContent = status.message;
      statusBox.className = 'status' + (status.phase === 'error' ? ' is-error' : status.phase === 'running' ? ' is-running' : '');
      if (status.appUrl) {
        appLink.href = status.appUrl;
        appLink.classList.add('is-visible');
        setBusy(false);
      }
      diagnosticsPanel.hidden = !status.details;
      diagnosticsText.textContent = status.details || '';
      if (status.phase === 'error') setBusy(false);
    }
    async function begin(payload) {
      setBusy(true);
      appLink.classList.remove('is-visible');
      try {
        const response = await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Setup-Token': token },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || '无法开始初始化。');
        showStatus(result);
      } catch (error) {
        showStatus({ phase: 'error', message: error.message });
        setBusy(false);
      }
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      begin(data);
    });
    reuseButton.addEventListener('click', () => begin({ reuseExisting: true }));
    copyLogButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(diagnosticsText.textContent || '');
      copyLogButton.textContent = '已复制';
    });
    setInterval(async () => {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (response.ok) showStatus(await response.json());
      } catch {}
    }, 1000);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", setupOrigin || "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(renderPage());
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/status") {
    sendJson(response, 200, setupStatus);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/start") {
    if (request.headers["x-setup-token"] !== csrfToken || request.headers.origin !== setupOrigin) {
      sendJson(response, 403, { message: "初始化请求校验失败。" });
      return;
    }
    if (["installing", "starting", "running"].includes(setupStatus.phase)) {
      sendJson(response, 409, setupStatus);
      return;
    }

    try {
      const input = await readJson(request);
      if (input.reuseExisting === true) {
        if (!environmentConfigured) {
          throw new Error("没有找到完整的已有配置。");
        }
        await saveEnvironment({});
      } else {
        await saveEnvironment(input);
      }
      setupStatus = {
        phase: "starting",
        message: "正在准备本地环境…",
        appUrl: null,
        details: null,
      };
      sendJson(response, 202, setupStatus);
      void startApplication();
    } catch (error) {
      sendJson(response, 400, {
        message: error instanceof Error ? error.message : "初始化失败。",
      });
    }
    return;
  }

  response.writeHead(404).end();
});

function openBrowser(url) {
  let command;
  let arguments_;
  if (process.platform === "win32") {
    command = process.env.ComSpec || "cmd.exe";
    arguments_ = ["/d", "/s", "/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    arguments_ = [url];
  } else {
    command = "xdg-open";
    arguments_ = [url];
  }
  const opener = spawn(command, arguments_, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  opener.unref();
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") return;
  setupOrigin = `http://127.0.0.1:${address.port}`;
  console.log(`通勤圈本地初始化：${setupOrigin}`);
  console.log("完成配置后请保持此窗口开启；按 Ctrl+C 可停止。");
  if (!skipBrowserOpen) openBrowser(setupOrigin);
});

function shutdown() {
  if (startupTimer) clearTimeout(startupTimer);
  if (devProcess?.pid && process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(devProcess.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else if (devProcess) {
    devProcess.kill("SIGTERM");
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
