export type PaymentMethodType = "card" | "upi" | "nach";

export type FailureCode =
  | "insufficient_funds"
  | "expired_card"
  | "card_replaced"
  | "upi_mandate_revoked"
  | "nach_account_closed"
  | "issuer_decline"
  | "card_limit_reached";

export interface CustomerSeed {
  id: string;
  fullName: string;
  firstName: string;
  displayPhone: string;
  email: string;
  planName: string;
  timezone: string;
  dob: string;
  pincode: string;
  paymentMethodType: PaymentMethodType;
  paymentMethodLabel: string;
  consent: boolean;
  dnc: boolean;
  disputeFlag: boolean;
  priorFailures12m: number;
  invoice: {
    amount: number;
    lateFee: number;
    dueDaysAgo: number;
    failureCode: FailureCode;
    retryOutcome: "succeed" | "fail";
    ledgerNote?: string;
  };
  scenario: string;
  personaTip: string;
}

export const CUSTOMERS: CustomerSeed[] = [
  {
    id: "cus_01",
    fullName: "Aarav Mehta",
    firstName: "Aarav",
    displayPhone: "+91 00000 00101",
    email: "aarav.mehta@example.com",
    planName: "Acme Fiber 300 Mbps",
    timezone: "Asia/Kolkata",
    dob: "1991-04-12",
    pincode: "560034",
    paymentMethodType: "card",
    paymentMethodLabel: "Visa ending 4417",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: { amount: 1199, lateFee: 0, dueDaysAgo: 2, failureCode: "insufficient_funds", retryOutcome: "succeed" },
    scenario: "Insufficient funds; money has since been added. Retry on the call succeeds.",
    personaTip: "You topped up your account yesterday. Say yes when offered an immediate retry.",
  },
  {
    id: "cus_02",
    fullName: "Priya Nair",
    firstName: "Priya",
    displayPhone: "+91 00000 00102",
    email: "priya.nair@example.com",
    planName: "Acme Fiber 1 Gbps",
    timezone: "Asia/Kolkata",
    dob: "1988-11-03",
    pincode: "682020",
    paymentMethodType: "card",
    paymentMethodLabel: "Mastercard ending 8823",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 1,
    invoice: { amount: 2499, lateFee: 100, dueDaysAgo: 3, failureCode: "expired_card", retryOutcome: "fail" },
    scenario: "Card on file expired. Needs a secure link to update the card, then pays.",
    personaTip: "Your card expired last month and you have a new one. Ask for the link, open it on your phone and pay.",
  },
  {
    id: "cus_03",
    fullName: "Rohan Gupta",
    firstName: "Rohan",
    displayPhone: "+91 00000 00103",
    email: "rohan.gupta@example.com",
    planName: "Acme Fiber 100 Mbps",
    timezone: "Asia/Kolkata",
    dob: "1995-01-27",
    pincode: "110017",
    paymentMethodType: "upi",
    paymentMethodLabel: "UPI AutoPay (HDFC)",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: { amount: 799, lateFee: 0, dueDaysAgo: 1, failureCode: "insufficient_funds", retryOutcome: "fail" },
    scenario: "Insufficient funds until payday. Promise-to-pay on a specific date.",
    personaTip: "Your salary arrives in 6 days. You cannot pay today; commit to paying on payday.",
  },
  {
    id: "cus_04",
    fullName: "Sneha Iyer",
    firstName: "Sneha",
    displayPhone: "+91 00000 00104",
    email: "sneha.iyer@example.com",
    planName: "Acme Fiber 300 Mbps",
    timezone: "Asia/Kolkata",
    dob: "1990-07-19",
    pincode: "600028",
    paymentMethodType: "card",
    paymentMethodLabel: "Visa ending 1290",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: { amount: 1199, lateFee: 0, dueDaysAgo: 4, failureCode: "card_replaced", retryOutcome: "fail" },
    scenario: "Card was reported lost and replaced. Agent must say only that the bank declined it, then send an update link.",
    personaTip: "Ask why it failed. You recently got a replacement card after losing your wallet.",
  },
  {
    id: "cus_05",
    fullName: "Vikram Singh",
    firstName: "Vikram",
    displayPhone: "+91 00000 00105",
    email: "vikram.singh@example.com",
    planName: "Acme Fiber 1 Gbps",
    timezone: "Asia/Kolkata",
    dob: "1986-02-08",
    pincode: "302001",
    paymentMethodType: "upi",
    paymentMethodLabel: "UPI AutoPay (ICICI)",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: { amount: 2499, lateFee: 0, dueDaysAgo: 2, failureCode: "upi_mandate_revoked", retryOutcome: "fail" },
    scenario: "UPI AutoPay mandate was revoked. No retry possible; needs a new mandate via link.",
    personaTip: "You cancelled some UPI mandates by mistake while cleaning up apps. You still want the service.",
  },
  {
    id: "cus_06",
    fullName: "Ananya Rao",
    firstName: "Ananya",
    displayPhone: "+91 00000 00106",
    email: "ananya.rao@example.com",
    planName: "Acme Fiber 300 Mbps",
    timezone: "Asia/Kolkata",
    dob: "1993-09-30",
    pincode: "500081",
    paymentMethodType: "nach",
    paymentMethodLabel: "NACH mandate, SBI account ending 5521",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: { amount: 1199, lateFee: 0, dueDaysAgo: 5, failureCode: "nach_account_closed", retryOutcome: "fail" },
    scenario: "Bank account behind the NACH mandate is closed. Must switch payment method.",
    personaTip: "You closed your old SBI account last month. Happy to switch to a card or UPI.",
  },
  {
    id: "cus_07",
    fullName: "Karan Malhotra",
    firstName: "Karan",
    displayPhone: "+91 00000 00107",
    email: "karan.malhotra@example.com",
    planName: "Acme Fiber 100 Mbps",
    timezone: "Asia/Kolkata",
    dob: "1989-12-14",
    pincode: "400050",
    paymentMethodType: "card",
    paymentMethodLabel: "RuPay ending 7781",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: {
      amount: 799,
      lateFee: 0,
      dueDaysAgo: 3,
      failureCode: "issuer_decline",
      retryOutcome: "fail",
      ledgerNote: "Manual UPI payment of 799 rupees received 2 days ago, pending reconciliation.",
    },
    scenario: "Customer says they already paid. Ledger shows an unreconciled manual payment. Agent logs it, pauses collection, escalates.",
    personaTip: "Insist you already paid by UPI two days ago. Do not agree to pay again.",
  },
  {
    id: "cus_08",
    fullName: "Meera Joshi",
    firstName: "Meera",
    displayPhone: "+91 00000 00108",
    email: "meera.joshi@example.com",
    planName: "Acme Fiber 1 Gbps",
    timezone: "Asia/Kolkata",
    dob: "1984-05-22",
    pincode: "411038",
    paymentMethodType: "card",
    paymentMethodLabel: "Visa ending 6604",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: { amount: 2499, lateFee: 150, dueDaysAgo: 6, failureCode: "insufficient_funds", retryOutcome: "fail" },
    scenario: "Hardship after job loss. Eligible for a late-fee waiver and a 3-part payment plan.",
    personaTip: "Speak in Hindi or Hinglish. You lost your job last month; ask for help and accept a plan.",
  },
  {
    id: "cus_09",
    fullName: "Arjun Das",
    firstName: "Arjun",
    displayPhone: "+91 00000 00109",
    email: "arjun.das@example.com",
    planName: "Acme Fiber 300 Mbps",
    timezone: "Asia/Kolkata",
    dob: "1992-03-05",
    pincode: "700091",
    paymentMethodType: "card",
    paymentMethodLabel: "Mastercard ending 2210",
    consent: true,
    dnc: true,
    disputeFlag: false,
    priorFailures12m: 1,
    invoice: { amount: 1199, lateFee: 0, dueDaysAgo: 4, failureCode: "issuer_decline", retryOutcome: "fail" },
    scenario: "On the do-not-call list. The dialer must refuse before any call is placed.",
    personaTip: "You should never receive this call.",
  },
  {
    id: "cus_10",
    fullName: "Divya Kapoor",
    firstName: "Divya",
    displayPhone: "+91 00000 00110",
    email: "divya.kapoor@example.com",
    planName: "Acme Fiber 1 Gbps",
    timezone: "Asia/Kolkata",
    dob: "1994-08-17",
    pincode: "122002",
    paymentMethodType: "card",
    paymentMethodLabel: "HDFC credit card ending 3348",
    consent: true,
    dnc: false,
    disputeFlag: false,
    priorFailures12m: 0,
    invoice: { amount: 2499, lateFee: 0, dueDaysAgo: 2, failureCode: "card_limit_reached", retryOutcome: "fail" },
    scenario: "Card limit reached. Partial payment now via link, promise-to-pay for the rest.",
    personaTip: "You can pay 1,000 rupees today and the rest after your card statement resets in 10 days.",
  },
];
