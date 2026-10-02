import type { AppConfig } from "../config.js";
import type { CustomerRow, LinkPurpose, Repo } from "../db/db.js";
import { maskPhone } from "../format.js";
import { POLICY, spokenRupees } from "../policy/offers.js";

export type Channel = "sms" | "email";

export interface Notifier {
  sendPaymentLink(input: { customer: CustomerRow; url: string; purpose: LinkPurpose; amount: number; token: string }): Promise<Channel[]>;
}

const PURPOSE_COPY: Record<LinkPurpose, string> = {
  pay_full: "pay your balance",
  partial: "make your part-payment",
  update_method: "update your payment method and clear the balance",
  new_mandate: "set up a new UPI AutoPay mandate and clear the balance",
};

export function createNotifier(repo: Repo, config: AppConfig, fetchImpl: typeof fetch = fetch): Notifier {
  return {
    async sendPaymentLink({ customer, url, purpose, amount, token }) {
      const body = `${config.companyName}: Hi ${customer.first_name}, use this secure link to ${PURPOSE_COPY[purpose]} (${spokenRupees(amount)}). Valid ${POLICY.linkTtlHours} hours. We will never ask for your OTP or PIN. ${url}`;
      repo.insertOutbox({
        customer_id: customer.id,
        channel: "sms",
        to_address: maskPhone(config.demoPhoneNumber),
        body,
        link_token: token,
        delivery: "simulated",
        provider_ref: null,
      });
      const channels: Channel[] = ["sms"];
      if (!config.resend) return channels;

      const id = repo.insertOutbox({
        customer_id: customer.id,
        channel: "email",
        to_address: config.resend.to,
        body,
        link_token: token,
        delivery: "queued",
        provider_ref: null,
      });
      void sendEmail(repo, config.resend, id, customer, config.companyName, body, fetchImpl);
      channels.push("email");
      return channels;
    },
  };
}

async function sendEmail(
  repo: Repo,
  resend: NonNullable<AppConfig["resend"]>,
  outboxId: number,
  customer: CustomerRow,
  company: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resend.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: resend.from,
        to: [resend.to],
        subject: `${company}: secure payment link for ${customer.full_name}`,
        text: body,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    repo.updateOutbox(outboxId, { delivery: res.ok ? "sent" : "failed", provider_ref: json.id ?? `http_${res.status}` });
  } catch (err) {
    repo.updateOutbox(outboxId, { delivery: "failed", provider_ref: err instanceof Error ? err.name : "error" });
  }
}
