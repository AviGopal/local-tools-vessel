// SPDX-License-Identifier: MIT
// The owner's mark that a span of the store was an outage or an install's restart (infra_window rows): a walk failure
// inside a span, of a status the row names, did not fail its move; the call was cut. records' fold reads the same rows
// the same way (fold.ts infraWindowsOf, moveFailed), so a failure records does not count, this detector does not file.
// Each row names a span (from_seq, to_seq) and the statuses it covers; its span ends at its own seq at the latest (no
// row excuses failures yet to come); the latest row per window_id decides, and one with retracted: true withdraws it;
// only the owner's rows count, and a row that does not say all three is ignored.
// A second copy of records' rule, so the two can drift: remove it once records answers which failures were cut and the
// detector reads that answer.
import type { Row } from "./walk-failure-classes";

type Window = { from: number; to: number; statuses: Set<number> };

const windowsOf = (rows: Row[]): Window[] => {
  const latest = new Map<string, Row>();
  for (const r of rows.filter((x) => x.shape === "infra_window" && x.role === "owner").sort((a, b) => a.seq - b.seq)) {
    latest.set(String(r.window_id ?? r.id), r);
  }
  return [...latest.values()].filter((r) => r.retracted !== true).flatMap((r) => {
    const from = Number(r.from_seq), to = Math.min(Number(r.to_seq), r.seq);
    const statuses = [r.statuses].flat().filter((x): x is number => typeof x === "number" && Number.isInteger(x));
    return Number.isFinite(from) && Number.isFinite(to) && from <= to && statuses.length > 0 ? [{ from, to, statuses: new Set(statuses) }] : [];
  });
};

// Whether a row is a walk failure cut inside one of the owner's windows (given its infra_window rows).
export const cutInWindow = (windowRows: Row[]): ((r: Row) => boolean) => {
  const windows = windowsOf(windowRows);
  return (r) => r.shape === "failure" && r.role === "walk" && windows.some((w) => r.seq >= w.from && r.seq <= w.to && w.statuses.has(Number(r.status)));
};
