import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { Repo } from "./db/db.js";
import { seedDatabase } from "./db/seed.js";
import { EventBus } from "./events/bus.js";
import { Dialer, type AgentBinding, type DialerDeps } from "./calls/dialer.js";
import { refreshDisposition } from "./calls/disposition.js";
import { buildCallDetail, buildState } from "./api/state.js";
import { createNotifier, type Notifier } from "./notify/outbox.js";
import { completePaymentLink } from "./payments/ledger.js";
import { balanceDue, spokenRupees } from "./policy/offers.js";
import { renderPayPage, renderPayResult } from "./pay/page.js";
import type { VoiceProvider } from "./retell/client.js";
import { executeTool } from "./retell/functions.js";
import { retellSignatureGuard } from "./retell/verify.js";
import { customerIdFromCall, handleRetellWebhook, type RetellCallPayload, type RetellWebhookPayload } from "./retell/webhooks.js";

export interface AppDeps {
  repo: Repo;
  config: AppConfig;
  provider?: VoiceProvider;
  binding: () => AgentBinding | undefined;
  publicBaseUrl: () => string;
  bus?: EventBus;
  notifier?: Notifier;
  webDist?: string;
  dialerTimings?: DialerDeps["timings"];
}

const TEST_CARD = "4242424242424242";

const requireJsonPosts: RequestHandler = (req, res, next) => {
  if (req.method !== "GET" && !req.is("application/json")) {
    res.status(415).json({ error: "Content-Type must be application/json" });
    return;
  }
  next();
};

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  if (status >= 500) console.error("[api]", err);
  res.status(status).json({ error: status < 500 && err?.expose ? String(err.message) : "internal error" });
};

export function createApp(deps: AppDeps) {
  const { repo, config } = deps;
  const bus = deps.bus ?? new EventBus();
  const notifier = deps.notifier ?? createNotifier(repo, config);
  const dialer = new Dialer({ repo, bus, config, provider: deps.provider, binding: deps.binding, timings: deps.dialerTimings });
  const pub = express.Router();
  const app = express();
  app.disable("x-powered-by");

  const retellRaw = [express.raw({ type: "*/*", limit: "2mb" }), retellSignatureGuard(config.retellApiKey, config.verifySignatures)];

  pub.post("/retell/webhook", ...retellRaw, (req: Request, res: Response) => {
    const outcome = handleRetellWebhook({ repo, bus }, req.body as RetellWebhookPayload);
    res.status(204).set("X-Webhook-Outcome", outcome).end();
  });

  pub.post("/retell/functions/:name", ...retellRaw, async (req: Request<{ name: string }>, res: Response) => {
    const body = req.body as { name?: string; call?: RetellCallPayload; args?: unknown };
    const callId = body.call?.call_id;
    if (!callId) {
      res.status(400).json({ ok: false, error: "MISSING_CALL" });
      return;
    }
    if (body.name !== undefined && body.name !== req.params.name) {
      res.status(400).json({ ok: false, error: "TOOL_NAME_MISMATCH" });
      return;
    }
    const result = await executeTool(
      { repo, bus, config, notifier, publicBaseUrl: deps.publicBaseUrl },
      {
        name: req.params.name,
        callId,
        customerId: customerIdFromCall(body.call ?? { call_id: callId }),
        channel: body.call?.call_type === "web_call" ? "web" : "phone",
        args: body.args,
      },
    );
    res.json(result);
  });

  pub.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(pub);
  app.use("/api", requireJsonPosts, express.json({ limit: "100kb" }));

  app.get("/api/state", (_req, res) => {
    void dialer.reconcileActiveCall(15_000);
    const binding = deps.binding();
    const publicBaseUrl = deps.publicBaseUrl();
    res.json(buildState(repo, config, dialer, { provisioned: !!binding?.fromNumber && binding.publicBaseUrl === publicBaseUrl, publicBaseUrl }));
  });

  app.get("/api/calls/:id", (req, res) => {
    const detail = buildCallDetail(repo, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(detail);
  });

  app.post("/api/customers/:id/call", async (req, res) => {
    const result = await dialer.dial(req.params.id);
    res.status(result.ok ? 201 : result.code === "PROVIDER_ERROR" ? 502 : 409).json(result);
  });

  app.post("/api/customers/:id/web-call", async (req, res) => {
    const result = await dialer.startWebCall(req.params.id);
    res.status(result.ok ? 201 : result.code === "PROVIDER_ERROR" ? 502 : 409).json(result);
  });

  app.post("/api/campaign/start", (_req, res) => {
    res.json(dialer.startCampaign());
  });

  app.post("/api/campaign/stop", (_req, res) => {
    res.json(dialer.stopCampaign());
  });

  app.post("/api/demo/reset", (_req, res) => {
    if (dialer.campaignState().running) {
      res.status(409).json({ error: "Stop the campaign first." });
      return;
    }
    seedDatabase(repo);
    bus.publish({ type: "demo.reset" });
    res.json({ ok: true });
  });

  app.get("/api/events", bus.sseHandler());

  pub.get("/pay/:token", (req, res) => {
    const link = repo.getLink(req.params.token);
    if (!link) {
      res.status(404).type("html").send(renderPayResult({ company: config.companyName, title: "Link not found", detail: "This payment link is invalid.", ok: false }));
      return;
    }
    if (link.status !== "sent") {
      const paid = link.status === "paid";
      res.type("html").send(
        renderPayResult({
          company: config.companyName,
          title: paid ? "Already paid" : "Link expired",
          detail: paid ? "This link has already been used. Thank you." : "Ask for a new link.",
          ok: paid,
        }),
      );
      return;
    }
    const customer = repo.getCustomer(link.customer_id)!;
    const invoice = repo.getInvoice(link.invoice_id)!;
    res.type("html").send(renderPayPage({ company: config.companyName, customer, invoice, link }));
  });

  pub.post("/pay/:token", express.urlencoded({ extended: false, limit: "10kb" }), (req, res) => {
    const token = req.params.token;
    const link = repo.getLink(token);
    const method = req.body?.method === "upi" ? "upi" : "card";
    if (link && link.status === "sent" && method === "card") {
      const digits = String(req.body?.card_number ?? "").replace(/\D/g, "");
      if (digits !== TEST_CARD) {
        const customer = repo.getCustomer(link.customer_id)!;
        const invoice = repo.getInvoice(link.invoice_id)!;
        res.status(422).type("html").send(
          renderPayPage({ company: config.companyName, customer, invoice, link, error: "Demo checkout: only the test card 4242 4242 4242 4242 is accepted." }),
        );
        return;
      }
    }
    const result = completePaymentLink(repo, token, method);
    if (!result.ok) {
      const copy: Record<typeof result.error, [string, string]> = {
        NOT_FOUND: ["Link not found", "This payment link is invalid."],
        ALREADY_PAID: ["Already paid", "This link has already been used. Thank you."],
        EXPIRED: ["Link expired", "Ask for a new link."],
        NOTHING_OWED: ["Nothing to pay", "This balance has already been settled."],
        PAUSED: ["Payment paused", "This account is under review. No payment is needed right now."],
      };
      const [title, detail] = copy[result.error];
      res.status(result.error === "NOT_FOUND" ? 404 : 409).type("html").send(renderPayResult({ company: config.companyName, title, detail, ok: result.error !== "EXPIRED" }));
      return;
    }
    if (result.link.call_id) refreshDisposition(repo, result.link.call_id);
    bus.publish({
      type: "payment.received",
      customerId: result.link.customer_id,
      callId: result.link.call_id ?? undefined,
      data: { amount: result.payment.applied, source: "link", purpose: result.link.purpose, fullyPaid: result.payment.fullyPaid },
    });
    res.type("html").send(
      renderPayResult({
        company: config.companyName,
        title: "Payment successful",
        detail: result.payment.fullyPaid
          ? "Your balance is cleared and autopay will continue as normal."
          : `Thank you. Remaining balance: ${spokenRupees(balanceDue(result.payment.invoice))}.`,
        ok: true,
      }),
    );
  });

  if (deps.webDist && existsSync(deps.webDist)) {
    const dist = deps.webDist;
    app.use(express.static(dist, { index: "index.html" }));
    app.get(/^\/(?!api|retell|pay|health).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }
  app.use(errorHandler);

  const publicApp = express();
  publicApp.disable("x-powered-by");
  publicApp.use(pub);
  publicApp.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  publicApp.use(errorHandler);

  return { app, publicApp, bus, dialer };
}
