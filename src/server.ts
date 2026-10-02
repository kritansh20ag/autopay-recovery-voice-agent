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

const { app } = createApp({
  repo,
  config,
  provider,
  binding: () => {
    const s = readProvisionedState();
    return s.agentId ? { agentId: s.agentId, agentVersion: s.agentVersion, fromNumber: s.fromNumber } : undefined;
  },
  publicBaseUrl: () => resolvePublicBaseUrl(config),
  webDist: path.resolve("web/dist"),
});

app.listen(config.port, () => {
  const warn = [
    !config.retellApiKey && "RETELL_API_KEY not set (calls disabled)",
    !config.demoPhoneNumber && "DEMO_PHONE_NUMBER not set (dialer blocks everything)",
    !readProvisionedState().agentId && "agent not provisioned (run `npm run provision`)",
  ].filter(Boolean);
  console.log(`[api] http://localhost:${config.port}  public: ${resolvePublicBaseUrl(config)}`);
  for (const w of warn) console.log(`[api] warning: ${w}`);
});
