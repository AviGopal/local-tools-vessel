// SPDX-License-Identifier: MIT
// walk_failure_detect: the walk's failures, classed (walk-failure-classes.ts), filed as gaps. It is the one call of an
// activity the owner schedules (a rhythm row naming its template), so each run is traced and graded like any walk run
// (the USER: "G2: detector tool", served beside records' reads under the node key, as pull-sync's detector writes).
//
// Everything it decides by is the owner's failure_rule row (target walk_failure), read at each run:
//   min_count, min_roots: a class is filed when it failed at least min_count times over at least min_roots roots
//                         within the last window_rows rows written to the store (records' head, not the rows read);
//   quiet_rows:           a filed class closes once it has not failed for quiet_rows rows AND its tool has been called
//                         since without failing that way (quiet with no call is not evidence: it stays open, said so);
//   write:                false is a dry run: the full report, and nothing written.
// A gap is one class: gap_id walk-failure:<class>, written by walk-failure-detector, role detector. It is written again
// only when what it says changes (status, count, roots or reopenings), so a rerun, or a second walk on the same store,
// writes nothing new. A class whose failures records stamped as blaming the callee (an outage, a timeout, a crash in
// what was called) is filed walkable false: shown, not offered to the walk, no one's debit (records reads that field). Failures on a gap's own
// repair are not counted toward it. Nothing here names a tool, a shape of failure or a threshold.
import { STALL, classesOf, type Klass, type Row } from "./walk-failure-classes";
import { resolveRecords } from "./walk-rows";

export const WRITER = "walk-failure-detector";
const ROLE = "detector";
const GAP_PREFIX = "walk-failure:";
const RULE_TARGET = "walk_failure";
// How much of a class a gap row carries: its newest failures as evidence, its roots, and the example body.
const EVIDENCE = 10;

type Rule = { min_count: number; min_roots: number; window_rows: number; quiet_rows: number; write: boolean };
export type Filed = { gap_id: string; class: string; tool: string; count: number; roots: number; walkable: boolean;
  action: "opened" | "updated" | "reopened" | "closed" | "unchanged" | "below" | "quiet_unexercised" };
export type Report = { shape: "walkFailureReport"; head: number; window_from: number; rule: Rule; write: boolean;
  failures: number; classes: Filed[]; written: number } | { error: string };

const read = async (pointer: Record<string, unknown>): Promise<Row[] | { error: string }> => {
  const r = await resolveRecords(pointer);
  if ("error" in r) return { error: r.error };
  const rows = Array.isArray(r.body) ? r.body : (r.body as { content?: unknown })?.content;
  return Array.isArray(rows) ? (rows as Row[]) : { error: `records answered no list (${String(pointer.shape)})` };
};

const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const ruleOf = (rows: Row[]): Rule | { error: string } => {
  const r = rows.filter((x) => x.role === "owner" && x.target === RULE_TARGET).sort((a, b) => a.seq - b.seq).at(-1);
  if (r === undefined) return { error: `no owner failure_rule row for ${RULE_TARGET}: nothing to decide by` };
  const v = { min_count: num(r.min_count), min_roots: num(r.min_roots), window_rows: num(r.window_rows), quiet_rows: num(r.quiet_rows) };
  const missing = Object.entries(v).filter(([, x]) => x === undefined).map(([k]) => k);
  if (missing.length > 0) return { error: `the failure_rule row ${r.id} lacks ${missing.join(", ")}` };
  return { ...(v as Omit<Rule, "write">), write: r.write === true };
};

const writeGap = async (row: Record<string, unknown>): Promise<boolean> => {
  const discovery = process.env.DISCOVERY_ENDPOINT?.trim();
  if (!discovery) return false;
  const key = process.env.METABOB_API_KEY ?? "";
  try {
    const r = await fetch(new URL("/resolve", discovery).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
      body: JSON.stringify({ pointer: { type: "record_write", row: { shape: "gap", input_refs: [], ...row }, writer: WRITER, role: ROLE } }),
      signal: AbortSignal.timeout(15_000),
    });
    const out = (await r.json().catch(() => undefined)) as { role?: unknown } | undefined;
    return r.ok && out?.role === ROLE;
  } catch {
    return false;
  }
};

// Whether the class's tool was called since `after` and that call did not fail this way: a move of the same tool (a
// started hop of it, or a selection of it with no hop) with no failure of its own call or selection.
// A stall class has no tool to call: quiet alone (no root said stalled for quiet_rows rows) is its evidence.
const exercised = (pool: Row[], k: Klass, after: number): boolean => {
  if (k.tool === STALL) return true;
  const failed = new Set(pool.filter((r) => r.shape === "failure" && r.role === "walk").flatMap((f) => [String(f.call_id), String(f.selection_ref)]));
  return pool.some((r) => r.seq > after && r.role === "walk" && (
    (r.shape === "hop" && r.phase === "started" && String(r.pointer_type) === k.tool && !failed.has(String(r.call_id))) ||
    (r.shape === "selection" && String(r.a) === k.tool && !failed.has(r.id))));
};

export const detect = async (): Promise<Report> => {
  const head = await resolveRecords({ head: true });
  if ("error" in head) return { error: `the store's head could not be read: ${head.error}` };
  const at = num((head.body as { at_seq?: unknown } | undefined)?.at_seq);
  if (at === undefined) return { error: "records answered no head (record_read head: true)" };
  const rules = await read({ shape: "failure_rule" });
  if (!Array.isArray(rules)) return rules;
  const rule = ruleOf(rules);
  if ("error" in rule) return rule;
  const from = Math.max(0, at - Math.max(rule.window_rows, rule.quiet_rows));
  const parts = await Promise.all(["failure", "selection", "hop"].map((shape) => read({ shape, after_seq: from })));
  const bad = parts.find((p) => !Array.isArray(p)) as { error: string } | undefined;
  if (bad !== undefined) return bad;
  const pool = (parts as Row[][]).flat();
  // The rows a direct call was made from (its selection's from): read by id, since a request can be older than the window.
  const fromIds = [...new Set(pool.filter((r) => r.shape === "selection" && typeof r.from === "string").map((r) => String(r.from)))];
  const asked = fromIds.length === 0 ? [] : await read({ ids: fromIds });
  if (!Array.isArray(asked)) return asked;
  const gaps = await read({ shape: "gap" });
  if (!Array.isArray(gaps)) return gaps;
  const mine = gaps.filter((g) => g.writer === WRITER && g.role === ROLE && String(g.gap_id ?? "").startsWith(GAP_PREFIX)).sort((a, b) => a.seq - b.seq);
  const latest = new Map<string, Row>();
  const rootsOf = new Map<string, Set<string>>();
  for (const g of mine) {
    const id = String(g.gap_id);
    latest.set(id, g);
    rootsOf.set(id.slice(GAP_PREFIX.length), (rootsOf.get(id.slice(GAP_PREFIX.length)) ?? new Set()).add(g.id));
  }
  const windowFrom = Math.max(0, at - rule.window_rows);
  const recent = classesOf([...pool, ...asked].filter((r) => r.shape !== "failure" || r.seq > windowFrom), rootsOf);
  const all = new Map(classesOf([...pool, ...asked], rootsOf).map((k) => [k.key, k]));
  const out: Filed[] = [];
  let written = 0;
  const put = async (row: Record<string, unknown>) => { if (rule.write && await writeGap(row)) written++; };
  const seen = new Set<string>();
  for (const k of recent) {
    const gap_id = GAP_PREFIX + k.key;
    // Quiet for quiet_rows though still inside the window (a rule whose quiet is shorter than its window): a close
    // candidate, decided below as any quiet class is.
    if (at - k.last_seq >= rule.quiet_rows && latest.get(gap_id)?.status === "open") continue;
    seen.add(gap_id);
    const prev = latest.get(gap_id);
    const filed: Filed = { gap_id, class: k.key, tool: k.tool, count: k.failures.length, roots: k.roots.length, walkable: !k.infra, action: "below" };
    const due = k.failures.length >= rule.min_count && k.roots.length >= rule.min_roots;
    if (!due && (prev === undefined || prev.status !== "open")) { out.push(filed); continue; }
    const reopened = Number(prev?.reopened ?? 0) + (prev !== undefined && prev.status !== "open" ? 1 : 0);
    const row = { gap_id, status: "open", category: "walk_failure", walkable: !k.infra, tool: k.tool, kind: k.kind, refused: k.refused,
      blames: k.blames, waits_for: k.waits_for, status_band: k.status_band, signature: k.signature.slice(0, 500), example: k.example,
      count: k.failures.length, root_count: k.roots.length, roots: k.roots.slice(-EVIDENCE), evidence: k.failures.slice(-EVIDENCE),
      first_seq: k.first_seq, last_seq: k.last_seq, reopened, window_rows: rule.window_rows, head: at }
    const same = prev !== undefined && prev.status === "open" && prev.count === row.count && prev.root_count === row.root_count && prev.walkable === row.walkable;
    filed.action = same ? "unchanged" : prev === undefined ? "opened" : prev.status !== "open" ? "reopened" : "updated";
    if (!same) await put(row);
    out.push(filed);
  }
  // A filed class with no failure in the window: closed once quiet for quiet_rows and called since without failing so.
  for (const [gap_id, g] of latest) {
    if (seen.has(gap_id) || g.status !== "open") continue;
    const key = gap_id.slice(GAP_PREFIX.length);
    const k = all.get(key);
    const last = Number(k?.last_seq ?? g.last_seq ?? 0);
    const filed: Filed = { gap_id, class: key, tool: String(g.tool), count: Number(g.count ?? 0), roots: Number(g.root_count ?? 0), walkable: g.walkable !== false, action: "unchanged" };
    if (at - last >= rule.quiet_rows) {
      const tool = { ...(k ?? {}), tool: String(g.tool) } as Klass;
      if (exercised(pool, tool, last)) {
        filed.action = "closed";
        await put({ ...Object.fromEntries(Object.entries(g).filter(([f]) => !["id", "seq", "t", "writer", "role", "by_key"].includes(f))),
          status: "closed", closed_reason: `no failure of this class for ${at - last} rows, and its tool was called since without it`, head: at });
      } else filed.action = "quiet_unexercised";
    }
    out.push(filed);
  }
  return { shape: "walkFailureReport", head: at, window_from: windowFrom, rule, write: rule.write, failures: pool.filter((r) => r.shape === "failure").length, classes: out, written };
};
