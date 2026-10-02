import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(blank, z.string().optional());
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "must be E.164, e.g. +910000012345");

const EnvSchema = z.object({
  RETELL_API_KEY: optionalString,
  DEMO_PHONE_NUMBER: z.preprocess(blank, e164.optional()),
  ALLOWED_DIAL_NUMBERS: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []),
    z.array(e164),
  ),
  COMPANY_NAME: z.preprocess(blank, z.string().default("Acme Fiber")),
  AGENT_NAME: z.preprocess(blank, z.string().default("Asha")),
  RETELL_LLM_MODEL: z.preprocess(blank, z.string().default("gpt-4.1")),
  RETELL_VOICE_ID: optionalString,
  RETELL_AREA_CODE: z.preprocess(blank, z.coerce.number().int().optional()),
  PORT: z.preprocess(blank, z.coerce.number().int().default(3000)),
  PUBLIC_BASE_URL: z.preprocess(blank, z.url().optional()),
  CALLING_WINDOW_START_HOUR: z.preprocess(blank, z.coerce.number().int().min(0).max(23).default(8)),
  CALLING_WINDOW_END_HOUR: z.preprocess(blank, z.coerce.number().int().min(1).max(24).default(19)),
  DB_PATH: z.preprocess(blank, z.string().default("data/app.db")),
  RESEND_API_KEY: optionalString,
  RESEND_FROM: z.preprocess(blank, z.string().default("Acme Fiber <onboarding@resend.dev>")),
  DEMO_EMAIL: optionalString,
  VERIFY_RETELL_SIGNATURES: z.preprocess(blank, z.enum(["true", "false"]).default("true")),
});

export interface AppConfig {
  retellApiKey?: string;
  demoPhoneNumber?: string;
  allowedDialNumbers: string[];
  companyName: string;
  agentName: string;
  llmModel: string;
  voiceId?: string;
  areaCode?: number;
  port: number;
  publicBaseUrl?: string;
  callingWindow: { startHour: number; endHour: number };
  dbPath: string;
  resend?: { apiKey: string; from: string; to: string };
  verifySignatures: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const e = parsed.data;
  const allowed = e.ALLOWED_DIAL_NUMBERS.length ? e.ALLOWED_DIAL_NUMBERS : e.DEMO_PHONE_NUMBER ? [e.DEMO_PHONE_NUMBER] : [];
  return {
    retellApiKey: e.RETELL_API_KEY,
    demoPhoneNumber: e.DEMO_PHONE_NUMBER,
    allowedDialNumbers: allowed,
    companyName: e.COMPANY_NAME,
    agentName: e.AGENT_NAME,
    llmModel: e.RETELL_LLM_MODEL,
    voiceId: e.RETELL_VOICE_ID,
    areaCode: e.RETELL_AREA_CODE,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/$/, ""),
    callingWindow: { startHour: e.CALLING_WINDOW_START_HOUR, endHour: e.CALLING_WINDOW_END_HOUR },
    dbPath: e.DB_PATH,
    resend: e.RESEND_API_KEY && e.DEMO_EMAIL ? { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM, to: e.DEMO_EMAIL } : undefined,
    verifySignatures: e.VERIFY_RETELL_SIGNATURES === "true",
  };
}

export interface ProvisionedState {
  llmId?: string;
  agentId?: string;
  agentVersion?: number;
  fromNumber?: string;
  voiceId?: string;
  smokeAgentId?: string;
  smokeLlmId?: string;
  publicBaseUrl?: string;
  provisionedAt?: string;
}

const STATE_FILE = path.resolve(".retell.json");
const RUNTIME_FILE = path.resolve(".runtime.json");

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function readProvisionedState(): ProvisionedState {
  return readJson<ProvisionedState>(STATE_FILE) ?? {};
}

export function writeProvisionedState(patch: Partial<ProvisionedState>): ProvisionedState {
  const next = { ...readProvisionedState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function readRuntimeBaseUrl(): string | undefined {
  return readJson<{ publicBaseUrl?: string }>(RUNTIME_FILE)?.publicBaseUrl;
}

export function writeRuntimeBaseUrl(publicBaseUrl: string): void {
  writeFileSync(RUNTIME_FILE, JSON.stringify({ publicBaseUrl }, null, 2) + "\n");
}

export function resolvePublicBaseUrl(config: AppConfig): string {
  return config.publicBaseUrl ?? readRuntimeBaseUrl() ?? `http://localhost:${config.port}`;
}
