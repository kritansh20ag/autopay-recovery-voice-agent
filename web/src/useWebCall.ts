import { useCallback, useEffect, useRef, useState } from "react";
import type { RetellWebClient } from "retell-client-js-sdk";
import { api } from "./api";

export interface Utterance {
  role: string;
  content: string;
}

export type WebCallStatus = "idle" | "connecting" | "live" | "ended" | "error";

export function useWebCall(onError: (msg: string) => void) {
  const client = useRef<RetellWebClient | null>(null);
  const [status, setStatus] = useState<WebCallStatus>("idle");
  const [callId, setCallId] = useState<string>();
  const [customerId, setCustomerId] = useState<string>();
  const [agentTalking, setAgentTalking] = useState(false);
  const [utterances, setUtterances] = useState<Utterance[]>([]);

  useEffect(() => () => client.current?.stopCall(), []);

  const start = useCallback(
    async (id: string) => {
      if (client.current) return;
      setStatus("connecting");
      setCustomerId(id);
      setUtterances([]);
      const res = await api.webCall(id);
      if (!res.ok) {
        setStatus("idle");
        setCustomerId(undefined);
        onError(res.reason);
        return;
      }
      const { RetellWebClient: Client } = await import("retell-client-js-sdk");
      const c = new Client();
      client.current = c;
      setCallId(res.callId);
      c.on("call_started", () => setStatus("live"));
      c.on("agent_start_talking", () => setAgentTalking(true));
      c.on("agent_stop_talking", () => setAgentTalking(false));
      c.on("update", (u: { transcript?: Utterance[] }) => {
        if (u.transcript) setUtterances(u.transcript.slice(-40));
      });
      c.on("call_ended", () => {
        setStatus("ended");
        setAgentTalking(false);
        client.current = null;
      });
      c.on("error", (e: unknown) => {
        setStatus("error");
        client.current?.stopCall();
        client.current = null;
        onError(`Web call error: ${e instanceof Error ? e.message : String(e)}`);
      });
      try {
        await c.startCall({ accessToken: res.accessToken, callId: res.callId, transport: res.transport as never, iceServers: res.iceServers });
      } catch (e) {
        client.current = null;
        setStatus("error");
        onError(`Could not start the browser call: ${e instanceof Error ? e.message : String(e)}. Allow microphone access and retry.`);
      }
    },
    [onError],
  );

  const stop = useCallback(() => {
    client.current?.stopCall();
  }, []);

  return { status, callId, customerId, agentTalking, utterances, start, stop };
}
