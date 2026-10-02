import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date in YYYY-MM-DD");
const rupees = z.coerce.number().int().min(1).max(100_000).describe("Whole rupees, e.g. 1000");

export const TOOL_SPECS = {
  verify_identity: {
    gated: false,
    description:
      "Verify the person on the line is the account holder. Ask for BOTH their date of birth and the 6-digit PIN code of the service address, then call this once. Never reveal which detail was wrong.",
    args: z.object({
      date_of_birth: ymd.describe("Customer's date of birth converted to YYYY-MM-DD"),
      pincode: z.string().describe("6-digit PIN code of the service address, digits only"),
    }),
  },
  get_account_summary: {
    gated: true,
    description:
      "After successful verification, fetch the failed autopay details: amount, reason (customer-safe wording), payment method on file and the options policy allows. Call this before explaining the issue.",
    args: z.object({}),
  },
  retry_payment: {
    gated: true,
    description:
      "Retry the failed autopay right now on the payment method already on file. Only call after the customer explicitly agrees to an immediate retry.",
    args: z.object({
      customer_confirmed: z.boolean().describe("True only if the customer just said yes to retrying now"),
    }),
  },
  send_payment_link: {
    gated: true,
    description:
      "Send a secure payment link by SMS. purpose=pay_full pays the balance, partial pays part of it (amount required), update_method replaces the card/bank and clears the balance, new_mandate re-creates UPI AutoPay and clears the balance. Use this instead of ever taking card or bank details on the call.",
    args: z.object({
      purpose: z.enum(["pay_full", "partial", "update_method", "new_mandate"]),
      amount: rupees.nullish().describe("Required only for purpose=partial, otherwise null"),
    }),
  },
  record_promise_to_pay: {
    gated: true,
    description:
      "Record the customer's commitment to pay on a specific date (at most [[PROMISE_MAX_DAYS]] days away). Confirm the date out loud first.",
    args: z.object({
      promise_date: ymd,
      amount: rupees.nullish().describe("Null means the full remaining balance"),
    }),
  },
  set_up_payment_plan: {
    gated: true,
    description:
      "Split the remaining balance into 2 or 3 instalments for customers who cannot pay in full soon (e.g. hardship). Read the schedule back to the customer.",
    args: z.object({ installments: z.coerce.number().int().min(2).max(3).describe("Number of instalments: 2 or 3") }),
  },
  waive_late_fee: {
    gated: true,
    description:
      "Waive the late fee if policy allows. Only offer when get_account_summary says fee_waiver_eligible is true, typically for hardship or a first failure.",
    args: z.object({}),
  },
  report_already_paid: {
    gated: true,
    description:
      "Customer says they already paid. Capture what they say; the system checks the ledger, pauses collection and opens a review.",
    args: z.object({
      paid_on: z.string().nullish().describe("When they say they paid, as they described it"),
      method: z.string().nullish().describe("How they say they paid, e.g. UPI, card, cash"),
      reference: z.string().nullish().describe("Any transaction reference they can read out"),
    }),
  },
  log_dispute: {
    gated: true,
    description: "Customer disputes the charge itself. Stop collecting, log the reason and tell them a specialist will review it in writing.",
    args: z.object({ reason: z.string().min(1) }),
  },
  schedule_callback: {
    gated: false,
    description:
      "Customer asks to be called back later. Allowed between [[WINDOW_START]] and [[WINDOW_END]] their local time, within [[CALLBACK_MAX_DAYS]] days. Works before verification too (it reveals nothing).",
    args: z.object({
      callback_time_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe("Local time YYYY-MM-DDTHH:mm"),
    }),
  },
  mark_do_not_call: {
    gated: false,
    description: "Customer asks to stop calling. Call immediately, confirm politely, then end the call. Do not argue or try to collect.",
    args: z.object({ reason: z.string().nullish() }),
  },
  escalate_to_human: {
    gated: false,
    description: "Customer asks for a human, is in serious hardship, is upset, or the situation is outside policy. Creates a ticket for a specialist callback.",
    args: z.object({
      category: z.enum(["hardship", "complaint", "requested_human", "other"]),
      reason: z.string().min(1),
    }),
  },
  report_wrong_party: {
    gated: false,
    description:
      "The person is not the account holder (third party) or says this is a wrong number. Disclose nothing about the account, call this, then end the call politely.",
    args: z.object({ kind: z.enum(["third_party", "wrong_number"]) }),
  },
} satisfies Record<string, { gated: boolean; description: string; args: z.ZodObject }>;

export type ToolName = keyof typeof TOOL_SPECS;
export type ToolArgs<N extends ToolName> = z.infer<(typeof TOOL_SPECS)[N]["args"]>;

export const TOOL_NAMES = Object.keys(TOOL_SPECS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_SPECS, name);
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export function toolParametersJsonSchema(name: ToolName): ToolParameters {
  const { properties = {} } = z.toJSONSchema(TOOL_SPECS[name].args, { io: "input" }) as Partial<ToolParameters>;
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
