import { spawn } from "node:child_process";
import { join } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const backendPort = process.env.AGENTIC_BACKEND_PORT ?? process.env.NEST_PORT ?? process.env.PORT ?? "3000";
const uiPort = process.env.WEB_REACT_PORT ?? process.env.UI_PORT ?? "3001";
const backendUrl = process.env.AGENTIC_BACKEND_URL ?? `http://127.0.0.1:${backendPort}`;
const browserOperateBaseUrl = process.env.BROWSER_OPERATE_BASE_URL ?? "http://127.0.0.1:18080";
const telegramBotBaseUrl = process.env.CHANNEL_TELEGRAM_BASE_URL ?? process.env.TELEGRAM_BOT_BASE_URL ?? "http://127.0.0.1:18081";
const artifactRoot = process.env.ARTIFACT_ROOT ?? join(process.cwd(), "workspace", "artifacts");
const searxngBaseUrl = process.env.SEARXNG_BASE_URL ?? "http://127.0.0.1:8080";

const children = [];
let shuttingDown = false;

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
    env: {
      ...process.env,
      ...options.env,
    },
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children) {
      if (other !== child && !other.killed) other.kill("SIGTERM");
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    console.error(`[${name}] ${error.message}`);
    process.exit(1);
  });
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`Starting Agentic API at ${backendUrl}`);
console.log(`Starting React console at http://127.0.0.1:${uiPort}`);
console.log(`Using browser.operate service at ${browserOperateBaseUrl}`);
console.log(`Using channel.telegram service at ${telegramBotBaseUrl}`);
console.log(`Using local artifact root at ${artifactRoot}`);
console.log(`Using web.search provider at ${searxngBaseUrl}`);
console.log("Legacy console remains available with: npm run web:legacy:dev");

start("api", npm, ["run", "web:api:dev"], {
  env: {
    NEST_PORT: backendPort,
    PORT: backendPort,
    SEARXNG_BASE_URL: searxngBaseUrl,
    BROWSER_OPERATE_BASE_URL: browserOperateBaseUrl,
    CHANNEL_TELEGRAM_BASE_URL: telegramBotBaseUrl,
    TELEGRAM_BOT_BASE_URL: telegramBotBaseUrl,
    ARTIFACT_ROOT: artifactRoot,
  },
});

start("react", npm, ["--prefix", "web-react", "run", "dev", "--", "--host", "127.0.0.1", "--port", uiPort], {
  env: {
    AGENTIC_BACKEND_URL: backendUrl,
  },
});
