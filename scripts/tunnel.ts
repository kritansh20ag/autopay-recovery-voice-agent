import { spawn } from "node:child_process";
import { loadConfig, writeRuntimeBaseUrl } from "../src/config.js";
import { provision } from "../src/agent/provision.js";
import { createRetell, describeProviderError } from "../src/retell/client.js";

const config = loadConfig();
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${config.port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});

child.on("error", (err) => {
  console.error(`[tunnel] could not start cloudflared (${err.message}). Install it with: brew install cloudflared`);
  process.exit(1);
});

let announced = false;
const onOutput = async (chunk: Buffer) => {
  const match = URL_PATTERN.exec(chunk.toString());
  if (!match || announced) return;
  announced = true;
  const url = match[0];
  writeRuntimeBaseUrl(url);
  console.log(`[tunnel] public URL ${url}`);
  if (!(await waitForHealth(url, 60_000))) {
    console.error("[tunnel] tunnel is up but /health is not reachable through it yet; provisioning anyway");
  }
  if (!config.retellApiKey) {
    console.log("[tunnel] RETELL_API_KEY not set; skipping provisioning");
    return;
  }
  try {
    const s = await provision(createRetell(config.retellApiKey), config, url, (m) => console.log(`[provision] ${m}`));
    console.log(`[tunnel] ready: agent ${s.agentId} v${s.agentVersion} on ${s.fromNumber}. Dashboard: http://localhost:${config.port}`);
  } catch (err) {
    console.error(`[provision] failed: ${describeProviderError(err)}`);
  }
};

child.stdout.on("data", onOutput);
child.stderr.on("data", onOutput);

const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
