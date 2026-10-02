// A copy of drizzle/ that stops after migration <maxIdx>, to build databases at an older
// schema (e.g. before signed webhooks or encryption) and then migrate them for real.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function migrationsUpTo(maxIdx, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((e) => e.idx <= maxIdx);
  writeFileSync(join(outDir, "meta/_journal.json"), JSON.stringify(journal, null, 2));
  for (const f of readdirSync("drizzle")) {
    if (f.endsWith(".sql") && Number(f.slice(0, 4)) <= maxIdx) cpSync(join("drizzle", f), join(outDir, f));
  }
  return outDir;
}
