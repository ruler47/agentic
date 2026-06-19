import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

loadEnvFile(".env");
loadEnvFile(".env.local");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const backendPort = process.env.AGENTIC_BACKEND_PORT ?? process.env.NEST_PORT ?? process.env.PORT ?? "3000";
const uiPort = process.env.WEB_REACT_PORT ?? process.env.UI_PORT ?? "3001";
const backendUrl = process.env.AGENTIC_BACKEND_URL ?? `http://127.0.0.1:${backendPort}`;

process.env.SEARXNG_BASE_URL ??= "http://127.0.0.1:8080";
process.env.BROWSER_OPERATE_BASE_URL ??= "http://127.0.0.1:18080";
process.env.CHANNEL_TELEGRAM_BASE_URL ??= "http://127.0.0.1:18081";
process.env.TELEGRAM_BOT_BASE_URL ??= "http://127.0.0.1:18081";
process.env.ARTIFACT_ROOT ??= "workspace/artifacts";

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
console.log("Legacy console remains available with: npm run web:legacy:dev");

start("api", npm, ["run", "web:api:dev"], {
  env: {
    NEST_PORT: backendPort,
    PORT: backendPort,
  },
});

start("react", npm, ["--prefix", "web-react", "run", "dev", "--", "--host", "127.0.0.1", "--port", uiPort], {
  env: {
    AGENTIC_BACKEND_URL: backendUrl,
  },
});

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const body = readFileSync(path, "utf8");
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
