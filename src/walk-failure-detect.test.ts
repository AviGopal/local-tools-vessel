// walk_failure_detect files recurring classes of the walk's failures as gaps, by the owner's failure_rule row, counted
// against the store's head; writes only gaps, only as itself, only when what a gap says changes; closes a class only on
// evidence. records is a stub here that answers reads as the live one does (shape, ids, after_seq, head).
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { detect, WRITER } from "./walk-failure-detect";

type Row = Record<string, any>;
const KEY = "test-node-key";
const realFetch = globalThis.fetch;
const saved = { d: process.env.DISCOVERY_ENDPOINT, k: process.env.METABOB_API_KEY };
process.env.DISCOVERY_ENDPOINT = "http://discovery.test";
process.env.METABOB_API_KEY = KEY;
afterAll(() => {
  globalThis.fetch = realFetch;
  process.env.DISCOVERY_ENDPOINT = saved.d;
  process.env.METABOB_API_KEY = saved.k;
});

let rows: Row[] = [];
let head = 0;
const writes: Row[] = [];
beforeEach(() => {
  rows = [];
  head = 0;
  writes.length = 0;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if ((init?.headers as Record<string, string> | undefined)?.Authorization !== `ApiKey ${KEY}`) return new Response("no key", { status: 401 });
    const p = JSON.parse(String(init?.body)).pointer;
    if (p.type === "record_write") {
      writes.push(p);
      const row = { ...p.row, id: `gap-row-${writes.length}`, seq: ++head, writer: p.writer, role: p.role };
      rows.push(row);
      return Response.json(row);
    }
    if (p.head === true) return Response.json({ at_seq: head });
    let out = rows;
    if (p.shape !== undefined) out = out.filter((r) => r.shape === p.shape);
    if (p.ids !== undefined) out = out.filter((r) => p.ids.includes(r.id));
    if (p.after_seq !== undefined) out = out.filter((r) => r.seq > p.after_seq);
    return Response.json(out);
  }) as typeof fetch;
});

const rule = (over: Row = {}) => rows.push({ id: `rule${head}`, seq: ++head, shape: "failure_rule", role: "owner", target: "walk_failure",
  min_count: 3, min_roots: 2, window_rows: 1000, quiet_rows: 500, write: true, ...over });
// One call of a tool by the walk for a root, failing with body and fields; the clone path is the call's own argument.
const fail = (root: string, tool: string, cwd: string, f: Row) => {
  const s = { id: `s${++head}`, seq: head, shape: "selection", role: "walk", root, a: `call/${tool}` };
  const h = { id: `h${++head}`, seq: head, shape: "hop", role: "walk", phase: "started", selection_ref: s.id, call_id: `c${head}`, pointer_type: tool, args: { cwd } };
  const x = { id: `f${++head}`, seq: head, shape: "failure", role: "walk", selection_ref: s.id, call_id: h.call_id, input_refs: [root], ...f };
  rows.push(s, h, x);
};
const ok = (root: string, tool: string) => {
  const s = { id: `s${++head}`, seq: head, shape: "selection", role: "walk", root, a: `call/${tool}` };
  rows.push(s, { id: `h${++head}`, seq: head, shape: "hop", role: "walk", phase: "started", selection_ref: s.id, call_id: `c${head}`, pointer_type: tool, args: {} });
};
const missing = (root: string, cwd: string) => fail(root, "git_diff", cwd, { status: 422, blames: "request", body: `no such directory: ${cwd}` });
const outage = (root: string) => fail(root, "fs_read", "/x", { status: 502, blames: "callee", body: JSON.stringify({ error: "forward_failed" }) });
const filler = (n: number) => { for (let i = 0; i < n; i++) rows.push({ id: `o${++head}`, seq: head, shape: "outcome", role: "person" }); };
const report = async () => {
  const r = await detect();
  if ("error" in r) throw new Error(r.error);
  return r;
};
const gapRows = () => rows.filter((r) => r.shape === "gap");

describe("walk_failure_detect", () => {
  it("[MUST-FAIL] a class recurring over the rule's count and roots is ONE gap, written only as the detector; a rerun writes nothing", async () => {
    rule();
    for (const [root, cwd] of [["w1", "/trees/a"], ["w2", "/trees/b"], ["w2", "/trees/c"]]) missing(root, cwd);
    const r = await report();
    expect(r.written).toBe(1);
    expect(r.classes.map((c) => c.action)).toEqual(["opened"]);
    expect(writes.every((w) => w.writer === WRITER && w.role === "detector" && w.row.shape === "gap")).toBe(true);
    const [g] = gapRows();
    expect(g).toMatchObject({ status: "open", walkable: true, count: 3, root_count: 2, tool: "git_diff", signature: "no such directory: <cwd>" });
    expect(String(g.gap_id).startsWith("walk-failure:")).toBe(true);
    expect((await report()).written).toBe(0);
  });

  it("[MUST-FAIL] the owner's rule decides: a dry run (write false) reports and writes nothing; below count or roots, no gap", async () => {
    rule({ write: false });
    for (const root of ["w1", "w2", "w3"]) missing(root, `/trees/${root}`);
    const r = await report();
    expect([r.write, r.written, writes.length, r.classes[0].action]).toEqual([false, 0, 0, "opened"]);
    rule({ min_count: 4 });
    expect((await report()).classes[0].action).toBe("below");
    rule({ min_count: 1, min_roots: 4 });
    expect((await report()).classes[0].action).toBe("below");
    expect(writes.length).toBe(0);
  });

  it("[MUST-FAIL] the window counts rows written to the store (records' head), not the rows read", async () => {
    rule({ window_rows: 50 });
    for (const root of ["w1", "w2", "w3"]) missing(root, `/trees/${root}`);
    filler(60); // other work since: the failures are now older than the window
    expect((await report()).classes).toEqual([]);
    expect(writes.length).toBe(0);
  });

  it("[MUST-FAIL] a callee that never answered (an outage) is filed walkable false: shown, not the walk's work", async () => {
    rule();
    for (const root of ["w1", "w2", "w3"]) outage(root);
    const r = await report();
    expect(r.classes[0]).toMatchObject({ action: "opened", walkable: false });
    expect(gapRows()[0].walkable).toBe(false);
  });

  it("[MUST-FAIL] a class closes only quiet AND called again without it; quiet with no call stays open; a recurrence reopens it", async () => {
    rule();
    for (const root of ["w1", "w2", "w3"]) missing(root, `/trees/${root}`);
    await report();
    filler(1100); // quiet past window and quiet_rows, the tool not called
    expect((await report()).classes[0].action).toBe("quiet_unexercised");
    expect(gapRows().at(-1)?.status).toBe("open");
    ok("w4", "git_diff"); // called again, no failure
    expect((await report()).classes[0].action).toBe("closed");
    expect(gapRows().at(-1)).toMatchObject({ status: "closed" });
    for (const root of ["w5", "w6", "w7"]) missing(root, `/trees/${root}`);
    const r = await report();
    expect(r.classes[0].action).toBe("reopened");
    expect(gapRows().at(-1)).toMatchObject({ status: "open", reopened: 1 });
  });

  it("[MUST-FAIL] failures on a gap's own repair are not counted toward it", async () => {
    rule();
    for (const root of ["w1", "w2", "w3"]) missing(root, `/trees/${root}`);
    await report();
    const own = gapRows()[0].id;
    for (const cwd of ["/trees/r1", "/trees/r2"]) missing(own, cwd);
    expect((await report()).written).toBe(0); // count unchanged: the repair's own failures are not the class's
  });

  it("[MUST-FAIL] calls that threw (status 0) and a callee's own 5xx are filed walkable false (qa P1, P2)", async () => {
    rule();
    for (const root of ["w1", "w2", "w3"]) fail(root, "fs_read", "/x", { status: 0, blames: "callee", body: "TypeError: fetch failed" });
    for (const root of ["w1", "w2", "w3"]) fail(root, "answer", "/x", { status: 502, blames: "callee", body: JSON.stringify({ prompt_ceiling: true }) });
    const r = await report();
    expect(r.classes.map((c) => [c.tool, c.action, c.walkable]).sort()).toEqual([["answer", "opened", false], ["fs_read", "opened", false]]);
  });

  it("[MUST-FAIL] a class quiet for quiet_rows closes though still inside a longer window", async () => {
    rule({ window_rows: 5000, quiet_rows: 100 });
    for (const root of ["w1", "w2", "w3"]) missing(root, `/trees/${root}`);
    await report();
    filler(150);
    ok("w4", "git_diff");
    expect((await report()).classes.map((c) => c.action)).toEqual(["closed"]);
  });

  it("[MUST-FAIL] no owner failure_rule: nothing decided, nothing written", async () => {
    rows.push({ id: "fake", seq: ++head, shape: "failure_rule", role: "walk", target: "walk_failure", min_count: 1, min_roots: 1, window_rows: 9, quiet_rows: 9, write: true });
    for (const root of ["w1", "w2"]) missing(root, `/trees/${root}`);
    const r = await detect();
    expect("error" in r && r.error).toContain("no owner failure_rule");
    expect(writes.length).toBe(0);
  });
});
