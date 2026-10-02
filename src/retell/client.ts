import Retell from "retell-sdk";

export interface PhoneCallRequest {
  fromNumber: string;
  toNumber: string;
  agentId: string;
  agentVersion?: number;
  dynamicVariables: Record<string, string>;
  metadata: Record<string, string>;
}

export interface WebCallRequest {
  agentId: string;
  agentVersion?: number;
  dynamicVariables: Record<string, string>;
  metadata: Record<string, string>;
}

export interface WebCallSession {
  callId: string;
  accessToken: string;
  transport?: string;
  iceServers?: unknown[];
}

export interface VoiceProvider {
  createPhoneCall(req: PhoneCallRequest): Promise<{ callId: string }>;
  createWebCall(req: WebCallRequest): Promise<WebCallSession>;
}

export function createRetell(apiKey: string): Retell {
  return new Retell({ apiKey, maxRetries: 1, timeout: 20_000 });
}

export function retellVoiceProvider(client: Retell): VoiceProvider {
  return {
    async createPhoneCall(req) {
      const call = await client.call.createPhoneCall({
        from_number: req.fromNumber,
        to_number: req.toNumber,
        override_agent_id: req.agentId,
        ...(req.agentVersion !== undefined ? { override_agent_version: req.agentVersion } : {}),
        retell_llm_dynamic_variables: req.dynamicVariables,
        metadata: req.metadata,
      });
      return { callId: call.call_id };
    },
    async createWebCall(req) {
      const call = await client.call.createWebCall({
        agent_id: req.agentId,
        ...(req.agentVersion !== undefined ? { agent_version: req.agentVersion } : {}),
        retell_llm_dynamic_variables: req.dynamicVariables,
        metadata: req.metadata,
      });
      return { callId: call.call_id, accessToken: call.access_token, transport: call.transport, iceServers: call.ice_servers };
    },
  };
}

export function describeProviderError(err: unknown): string {
  if (err instanceof Retell.APIError) {
    const body = err.error ? JSON.stringify(err.error) : err.message;
    return `Retell ${err.status ?? "error"}: ${body}`.slice(0, 500);
  }
  return err instanceof Error ? err.message : String(err);
}
