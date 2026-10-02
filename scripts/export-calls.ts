import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCallDetail } from "../src/api/state.js";
import { loadConfig } from "../src/config.js";
import { openDb, Repo } from "../src/db/db.js";

const config = loadConfig();
const repo = new Repo(openDb(config.dbPath));
const outDir = path.resolve("demo/calls");
mkdirSync(outDir, { recursive: true });

const calls = repo.listCalls(500).filter((c) => c.status === "ended");
for (const c of calls) {
  const detail = buildCallDetail(repo, c.id)!;
  const customer = repo.getCustomer(c.customer_id)!;
  const slug = `${c.created_at.slice(0, 16).replace(/[:T]/g, "-")}_${customer.id}_${c.disposition ?? "unknown"}`;
  const { recordingUrl: _r, publicLogUrl: _l, ...shareable } = detail;
  writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(shareable, null, 2) + "\n");
  const md = [
    `# ${customer.full_name} · ${detail.disposition ?? "unknown"}`,
    "",
    `- Channel: ${detail.channel} · Duration: ${Math.round((detail.durationMs ?? 0) / 1000)}s · Ended: ${detail.disconnectionReason ?? "n/a"}`,
    `- Summary: ${detail.summary ?? "n/a"}`,
    "",
    "## Tool calls",
    ...detail.tools.map((t) => `- \`${t.name}\` ${t.ok ? "ok" : "rejected"}: ${JSON.stringify(t.args)}`),
    "",
    "## Transcript",
    "",
    "```",
    detail.transcript ?? "",
    "```",
    "",
  ].join("\n");
  writeFileSync(path.join(outDir, `${slug}.md`), md);
}
console.log(`Exported ${calls.length} calls to ${outDir}`);
