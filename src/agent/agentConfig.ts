import { readFileSync } from "node:fs";
import type Retell from "retell-sdk";
import type { AppConfig } from "../config.js";
import { TOOL_NAMES, TOOL_SPECS, toolParametersJsonSchema } from "./tools.js";

export const PROMPT = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");

export const BEGIN_MESSAGE =
  "Hello, this is {{agent_name}}, an AI assistant calling from {{company_name}}. This call is recorded. Am I speaking with {{customer_full_name}}?";

export function voicemailText(config: AppConfig, callbackNumber: string): string {
  return `Hello, this is ${config.agentName} from ${config.companyName}. Please call us back at ${callbackNumber} at your convenience. Thank you.`;
}

export function buildLlmParams(config: AppConfig, publicBaseUrl: string): Retell.LlmCreateParams {
  const tools: NonNullable<Retell.LlmCreateParams["general_tools"]> = TOOL_NAMES.map((name) => ({
    type: "custom" as const,
    name,
    description: TOOL_SPECS[name].description,
    url: `${publicBaseUrl}/retell/functions/${name}`,
    method: "POST" as const,
    parameters: toolParametersJsonSchema(name),
    speak_during_execution: false,
    speak_after_execution: true,
    timeout_ms: 10_000,
    max_retry: 1,
  }));
  tools.push({ type: "end_call", name: "end_call", description: "End the call after the closing line, or when the flow says to end it." });

  return {
    model: config.llmModel as Retell.LlmCreateParams["model"],
    model_temperature: 0.2,
    tool_call_strict_mode: true,
    start_speaker: "agent",
    begin_message: BEGIN_MESSAGE,
    general_prompt: PROMPT,
    general_tools: tools,
    default_dynamic_variables: {
      agent_name: config.agentName,
      company_name: config.companyName,
      customer_full_name: "the account holder",
      customer_first_name: "there",
      callback_number: "the number we called from",
      today: new Date().toISOString().slice(0, 10),
      customer_timezone: "Asia/Kolkata",
      customer_id: "",
    },
  };
}

export const POST_CALL_ANALYSIS: NonNullable<Retell.AgentCreateParams["post_call_analysis_data"]> = [
  {
    type: "enum",
    name: "outcome",
    description: "Single best description of how the call ended for the failed autopay.",
    choices: [
      "paid_on_call",
      "payment_link_sent",
      "promise_to_pay",
      "payment_plan",
      "callback_requested",
      "already_paid_claim",
      "dispute",
      "hardship_escalated",
      "opted_out",
      "wrong_party",
      "verification_failed",
      "no_resolution",
    ],
  },
  { type: "string", name: "promise_date", description: "Date the customer committed to pay, YYYY-MM-DD, empty if none." },
  { type: "number", name: "amount_committed", description: "Rupees the customer paid or committed to pay on this call, 0 if none." },
  { type: "enum", name: "customer_language", description: "Main language the customer used.", choices: ["english", "hindi", "hinglish", "other"] },
  {
    type: "boolean",
    name: "agent_policy_violation",
    description:
      "True if the agent disclosed account details before identity verification, asked for card/OTP/PIN details, threatened the customer, or invented an amount or policy.",
  },
  { type: "string", name: "next_best_action", description: "One short sentence on what the collections team should do next." },
];

export function buildAgentParams(config: AppConfig, input: { llmId: string; voiceId: string; publicBaseUrl: string; callbackNumber: string }): Retell.AgentCreateParams {
  return {
    agent_name: `${config.companyName} autopay recovery`,
    response_engine: { type: "retell-llm", llm_id: input.llmId },
    voice_id: input.voiceId,
    language: ["en-IN", "hi-IN"],
    timezone: "Asia/Kolkata",
    webhook_url: `${input.publicBaseUrl}/retell/webhook`,
    webhook_events: ["call_started", "call_ended", "call_analyzed", "transcript_updated"],
    voicemail_option: { action: { type: "static_text", text: voicemailText(config, input.callbackNumber) } },
    max_call_duration_ms: 300_000,
    end_call_after_silence_ms: 20_000,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    boosted_keywords: [config.companyName, "autopay", "UPI", "AutoPay", "NACH", "mandate", "PIN code"],
    post_call_analysis_data: POST_CALL_ANALYSIS,
    data_storage_setting: "everything",
  };
}
