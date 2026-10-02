import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

export type AppEventType =
  | "dial.blocked"
  | "dial.placed"
  | "dial.failed"
  | "call.started"
  | "call.transcript"
  | "call.ended"
  | "call.analyzed"
  | "tool.invoked"
  | "link.sent"
  | "payment.received"
  | "campaign.updated"
  | "demo.reset";

export interface AppEvent {
  type: AppEventType;
  at: string;
  customerId?: string;
  callId?: string;
  data?: Record<string, unknown>;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: Omit<AppEvent, "at">): void {
    this.emitter.emit("event", { ...event, at: new Date().toISOString() } satisfies AppEvent);
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  waitFor(predicate: (event: AppEvent) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<AppEvent | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const done = (value: AppEvent | undefined) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => done(undefined);
      const unsubscribe = this.subscribe((e) => {
        if (predicate(e)) done(e);
      });
      const timer = setTimeout(() => done(undefined), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  sseHandler() {
    return (req: Request, res: Response) => {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
      res.write(": connected\n\n");
      const unsubscribe = this.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    };
  }
}
