import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const setupScript = path.join(scriptDirectory, "local-setup.mjs");

function startAssistant(scriptPath) {
  const child = spawn(process.execPath, [scriptPath, "--no-open"], {
    env: { ...process.env, COMMUTE_SETUP_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const origin = new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("初始化助手启动超时")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0]);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`初始化助手提前退出：${code ?? "未知"}`));
    });
  });

  return { child, origin };
}

test("识别 apps/web 下带 BOM、引号和 export 的环境配置且不回显密钥", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "commute-setup-"));
  const fixtureScriptDirectory = path.join(fixture, "scripts");
  const fixtureWebDirectory = path.join(fixture, "apps", "web");
  await mkdir(fixtureScriptDirectory, { recursive: true });
  await mkdir(fixtureWebDirectory, { recursive: true });
  await writeFile(
    path.join(fixtureScriptDirectory, "local-setup.mjs"),
    await readFile(setupScript, "utf8"),
    "utf8",
  );

  const secretValues = ["test-js-key", "test-security-code", "test-web-service-key"];
  await writeFile(
    path.join(fixtureWebDirectory, ".env.local"),
    `\uFEFFexport NEXT_PUBLIC_AMAP_JS_KEY="${secretValues[0]}"\nNEXT_PUBLIC_AMAP_JS_SECURITY_CODE='${secretValues[1]}'\nAMAP_WEB_SERVICE_KEY=${secretValues[2]}\n`,
    "utf8",
  );

  const assistant = startAssistant(path.join(fixtureScriptDirectory, "local-setup.mjs"));
  try {
    const response = await fetch(await assistant.origin);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /已识别 apps\/web\/\.env\.local/);
    assert.equal((html.match(/class="field-state is-detected"/g) ?? []).length, 3);
    for (const secret of secretValues) assert.equal(html.includes(secret), false);
  } finally {
    assistant.child.kill("SIGTERM");
    await rm(fixture, { recursive: true, force: true });
  }
});
