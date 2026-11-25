import type { Query, Row } from "./walk-rows.js";

// The whole suite's runs grow with the repository, so their bound is the owner's to set, up to a timer's largest delay:
// past 2^31 - 1 ms a timer fires at once, and the bound would cut every run at its start.
export const SUITE_MS_MAX = 2_147_483_647;

/**
 * How long each of the whole suite's two runs may take, as the owner sets it: its newest suite_bound row for this
 * repository or for none (suite_step_ms, in ms), clamped to a timer's largest delay. Newest wins whatever its scope: a
 * newer row naming no repo replaces an older one naming this repo, so the owner's last word is the bound. Only the
 * owner's rows are read: any other writer's row would set every suite's bound (a bound of 1 ms stops every suite, so
 * nothing passes). undefined when the newest such row names no positive number, or the rows cannot be read: then
 * git_diff's own step bound holds. Only the suite's runs read it: git, the scan and the typecheck do not grow with the
 * suite.
 */
export async function suiteBoundOf(rows: (q: Query) => Promise<Row[] | { error: string }>, repo: string): Promise<number | undefined> {
  const found = await rows({ shape: "suite_bound" });
  if (!Array.isArray(found)) return undefined;
  const row = found.filter((r) => r.role === "owner" && (r.repo === undefined || r.repo === repo)).sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0)).at(-1);
  const ms = row?.suite_step_ms;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.min(ms, SUITE_MS_MAX) : undefined;
}
