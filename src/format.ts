export function maskPhone(e164: string | undefined): string {
  if (!e164) return "your registered mobile";
  return `${e164.slice(0, 3)} ••••• •${e164.slice(-4)}`;
}
