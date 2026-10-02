import Retell from "retell-sdk";
import { pathToFileURL } from "node:url";
import { loadConfig, readProvisionedState, resolvePublicBaseUrl, writeProvisionedState, type AppConfig, type ProvisionedState } from "../config.js";
import { spokenPhone } from "../calls/dialer.js";
import { createRetell, describeProviderError } from "../retell/client.js";
import { buildAgentParams, buildLlmParams } from "./agentConfig.js";

type Log = (msg: string) => void;

const isNotFound = (err: unknown) => err instanceof Retell.APIError && err.status === 404;

const CALLING_CODES: Array<[string, string[]]> = [
  ["+971", ["AE"]],
  ["+91", ["IN"]],
  ["+65", ["SG"]],
  ["+61", ["AU"]],
  ["+49", ["DE"]],
  ["+44", ["GB"]],
  ["+1", ["US", "CA"]],
];

export function outboundCountries(config: AppConfig): string[] {
  const countries = new Set<string>();
  for (const n of config.allowedDialNumbers) {
    const match = CALLING_CODES.find(([code]) => n.startsWith(code));
    if (!match) throw new Error(`Unknown country for ${n}; add its calling code to CALLING_CODES in src/agent/provision.ts`);
    for (const c of match[1]) countries.add(c);
  }
  if (!countries.size) throw new Error("ALLOWED_DIAL_NUMBERS is empty; nothing could be dialled.");
  return [...countries];
}

export function numberNickname(config: AppConfig): string {
  return `${config.companyName} autopay demo`;
}

export async function ensureNumber(client: Retell, config: AppConfig, log: Log): Promise<string> {
  const state = readProvisionedState();
  if (state.fromNumber) {
    try {
      await client.phoneNumber.retrieve(state.fromNumber);
      return state.fromNumber;
    } catch (err) {
      if (!isNotFound(err)) throw err;
      log(`Number ${state.fromNumber} no longer exists on this account; buying a new one.`);
    }
  }
  const existing = (await client.phoneNumber.list()).items?.find((n) => n.nickname === numberNickname(config));
  if (existing) {
    log(`Reusing existing Retell number ${existing.phone_number}`);
    writeProvisionedState({ fromNumber: existing.phone_number });
    return existing.phone_number;
  }
  log(`Buying a US number${config.areaCode ? ` in area code ${config.areaCode}` : ""} (about $2/month)...`);
  const bought = await client.phoneNumber.create({
    ...(config.areaCode ? { area_code: config.areaCode } : {}),
    nickname: numberNickname(config),
    allowed_outbound_country_list: outboundCountries(config),
  });
  writeProvisionedState({ fromNumber: bought.phone_number });
  log(`Bought ${bought.phone_number}`);
  return bought.phone_number;
}

export async function pickVoice(client: Retell, config: AppConfig, state: ProvisionedState): Promise<string> {
  if (config.voiceId) return config.voiceId;
  if (state.voiceId) return state.voiceId;
  const voices = await client.voice.list();
  const indian = (v: Retell.VoiceResponse) => /india/i.test(v.accent ?? "");
  const choice =
    voices.find((v) => v.provider === "elevenlabs" && v.gender === "female" && indian(v)) ??
    voices.find((v) => v.gender === "female" && indian(v)) ??
    voices.find((v) => v.provider === "elevenlabs" && v.gender === "female") ??
    voices[0];
  if (!choice) throw new Error("No voices available on this Retell account.");
  return choice.voice_id;
}

export async function provision(client: Retell, config: AppConfig, publicBaseUrl: string, log: Log = console.log): Promise<ProvisionedState> {
  const fromNumber = await ensureNumber(client, config, log);
  const state = readProvisionedState();
  const voiceId = await pickVoice(client, config, state);

  const llmParams = buildLlmParams(config, publicBaseUrl);
  let llmId = state.llmId;
  if (llmId) {
    try {
      await client.llm.update(llmId, llmParams);
      log(`Updated Retell LLM ${llmId}`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      llmId = undefined;
    }
  }
  if (!llmId) {
    llmId = (await client.llm.create(llmParams)).llm_id;
    log(`Created Retell LLM ${llmId}`);
  }

  const agentParams = buildAgentParams(config, { llmId, voiceId, publicBaseUrl, callbackNumber: spokenPhone(fromNumber) });
  let agent: Retell.AgentResponse | undefined;
  if (state.agentId) {
    try {
      agent = await client.agent.update(state.agentId, agentParams);
      log(`Updated agent ${agent.agent_id} (version ${agent.version})`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  if (!agent) {
    agent = await client.agent.create(agentParams);
    log(`Created agent ${agent.agent_id} (version ${agent.version})`);
  }

  await client.phoneNumber.update(fromNumber, {
    outbound_agents: [{ agent_id: agent.agent_id, weight: 1 }],
    allowed_outbound_country_list: outboundCountries(config),
  });

  return writeProvisionedState({
    llmId,
    agentId: agent.agent_id,
    agentVersion: agent.version,
    fromNumber,
    voiceId,
    publicBaseUrl,
    provisionedAt: new Date().toISOString(),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadConfig();
  const baseUrl = resolvePublicBaseUrl(config);
  if (!config.retellApiKey) {
    console.error("RETELL_API_KEY is not set in .env");
    process.exit(1);
  }
  if (baseUrl.includes("localhost")) {
    console.error("No public URL. Run `npm run live` (starts the tunnel and provisions), or set PUBLIC_BASE_URL.");
    process.exit(1);
  }
  provision(createRetell(config.retellApiKey), config, baseUrl)
    .then((s) => console.log(`Provisioned: agent ${s.agentId} v${s.agentVersion}, number ${s.fromNumber}, tools -> ${baseUrl}`))
    .catch((err) => {
      console.error(`Provisioning failed: ${describeProviderError(err)}`);
      process.exit(1);
    });
}
