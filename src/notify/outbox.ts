import type { AppConfig } from "../config.js";
import type { CustomerRow, LinkPurpose, Repo } from "../db/db.js";
import { spokenRupees } from "../policy/offers.js";

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

export function maskPhone(e164: string | undefined): string {
  if (!e164) return "your registered mobile";
  return `${e164.slice(0, 3)} ••••• •${e164.slice(-4)}`;
}

export function createNotifier(repo: Repo, config: AppConfig, fetchImpl: typeof fetch = fetch): Notifier {
  return {
    async sendPaymentLink({ customer, url, purpose, amount, token }) {
      const body = `${config.companyName}: Hi ${customer.first_name}, use this secure link to ${PURPOSE_COPY[purpose]} (${spokenRupees(amount)}). Valid 24 hours. We will never ask for your OTP or PIN. ${url}`;
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
        delivery: "simulated",
        provider_ref: null,
      });
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.resend.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: config.resend.from,
            to: [config.resend.to],
            subject: `${config.companyName}: secure payment link for ${customer.full_name}`,
            text: body,
          }),
          signal: AbortSignal.timeout(5000),
        });
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        repo.updateOutbox(id, { delivery: res.ok ? "sent" : "failed", provider_ref: json.id ?? `http_${res.status}` });
        if (res.ok) channels.push("email");
      } catch (err) {
        repo.updateOutbox(id, { delivery: "failed", provider_ref: err instanceof Error ? err.name : "error" });
      }
      return channels;
    },
  };
}
