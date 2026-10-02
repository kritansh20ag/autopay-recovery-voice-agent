import path from "node:path";
import { createApp } from "./app.js";
import { loadConfig, readProvisionedState, resolvePublicBaseUrl } from "./config.js";
import { openDb, Repo } from "./db/db.js";
import { seedDatabase } from "./db/seed.js";
import { createRetell, retellVoiceProvider } from "./retell/client.js";

const config = loadConfig();
const repo = new Repo(openDb(config.dbPath));
if (!repo.listCustomers().length) seedDatabase(repo);

const provider = config.retellApiKey ? retellVoiceProvider(createRetell(config.retellApiKey)) : undefined;

const { app, publicApp } = createApp({
  repo,
  config,
  provider,
  binding: () => {
    const s = readProvisionedState();
    return s.agentId ? { agentId: s.agentId, agentVersion: s.agentVersion, fromNumber: s.fromNumber, publicBaseUrl: s.publicBaseUrl } : undefined;
  },
  publicBaseUrl: () => resolvePublicBaseUrl(config),
  webDist: path.resolve("web/dist"),
});

publicApp.listen(config.publicPort, "127.0.0.1", () => {
  console.log(`[public] http://127.0.0.1:${config.publicPort}  (Retell webhooks, tools and /pay only; point the tunnel here)`);
});

app.listen(config.port, "127.0.0.1", () => {
  const warn = [
    !config.verifySignatures && "VERIFY_RETELL_SIGNATURES=false: anyone with the tunnel URL can invoke tools",
    !config.retellApiKey && "RETELL_API_KEY not set (calls disabled)",
    !config.demoPhoneNumber && "DEMO_PHONE_NUMBER not set (dialer blocks everything)",
    !readProvisionedState().agentId && "agent not provisioned (run `npm run live`)",
    readProvisionedState().agentId &&
      readProvisionedState().publicBaseUrl !== resolvePublicBaseUrl(config) &&
      `agent was provisioned for ${readProvisionedState().publicBaseUrl}, not ${resolvePublicBaseUrl(config)}; tools and webhooks will not reach this server`,
  ].filter(Boolean);
  console.log(`[api] http://localhost:${config.port}  public: ${resolvePublicBaseUrl(config)}`);
  for (const w of warn) console.log(`[api] warning: ${w}`);
});
