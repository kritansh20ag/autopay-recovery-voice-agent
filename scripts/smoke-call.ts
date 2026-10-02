import { loadConfig, readProvisionedState, writeProvisionedState } from "../src/config.js";
import { ensureNumber, pickVoice } from "../src/agent/provision.js";
import { createRetell, describeProviderError } from "../src/retell/client.js";

const config = loadConfig();

async function main() {
  if (!config.retellApiKey) throw new Error("RETELL_API_KEY is not set in .env");
  const to = config.demoPhoneNumber;
  if (!to) throw new Error("DEMO_PHONE_NUMBER is not set in .env");
  if (!config.allowedDialNumbers.includes(to)) throw new Error(`${to} is not in ALLOWED_DIAL_NUMBERS`);

  const client = createRetell(config.retellApiKey);
  const fromNumber = await ensureNumber(client, config, console.log);
  const state = readProvisionedState();

  let smokeAgentId = state.smokeAgentId;
  if (!smokeAgentId) {
    const llm = await client.llm.create({
      start_speaker: "agent",
      begin_message: "Hello! This is a connectivity test from your autopay recovery demo. If you can hear me, the phone line works. Goodbye!",
      general_prompt: "You only say the opening line, then immediately end the call with the end_call tool.",
      general_tools: [{ type: "end_call", name: "end_call", description: "End the call." }],
    });
    const voiceId = await pickVoice(client, config, state);
    const agent = await client.agent.create({
      agent_name: "connectivity smoke test",
      response_engine: { type: "retell-llm", llm_id: llm.llm_id },
      voice_id: voiceId,
      language: "en-IN",
      max_call_duration_ms: 60_000,
    });
    smokeAgentId = agent.agent_id;
    writeProvisionedState({ smokeAgentId, smokeLlmId: llm.llm_id });
  }

  console.log(`Calling ${to} from ${fromNumber}...`);
  const call = await client.call.createPhoneCall({ from_number: fromNumber, to_number: to, override_agent_id: smokeAgentId });
  console.log(`Call ${call.call_id} registered; waiting for it to finish (answer your phone).`);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const c = await client.call.retrieve(call.call_id);
    process.stdout.write(`  status=${c.call_status}\r`);
    if (c.call_status === "ended" || c.call_status === "error" || c.call_status === "not_connected") {
      console.log(`\nResult: ${c.call_status}, disconnection_reason=${c.disconnection_reason ?? "n/a"}, duration=${c.duration_ms ?? 0}ms`);
      return;
    }
  }
  console.log("\nTimed out waiting for the call to end; check the Retell dashboard call history.");
}

main().catch((err) => {
  console.error(`Smoke call failed: ${describeProviderError(err)}`);
  process.exit(1);
});
