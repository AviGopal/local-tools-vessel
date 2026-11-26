// madeClone reads a clone from every walk row at its cwd: a field a row does not carry is unknown there, not a second
// clone. A refused land once recorded where the clone was without its origin_url and super_base; read as "", that one row
// made the clone two clones at one place, and every later commit or landing in it was refused for good. records is a stub.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { madeClone } from "./walk-rows";
import { recordRead, walkCall } from "./walk-call-rows.test-helper";

const CWD = "/workspace/git/walk-trees/concept-db-x";
const BASE = "7".repeat(40);
const CLONE = { shape: "gitWorktree", cwd: CWD, repo: "concept-db", branch: "dev", base: BASE, super_base: "5".repeat(40), origin_url: "https://example.invalid/concept-db.git" };

let rows: Array<Record<string, unknown>> = [];
const realFetch = globalThis.fetch;
const saved = { d: process.env.DISCOVERY_ENDPOINT, k: process.env.METABOB_API_KEY };
beforeEach(() => {
  process.env.DISCOVERY_ENDPOINT = "http://discovery.test";
  process.env.METABOB_API_KEY = "test-node-key";
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => Response.json(recordRead(rows, JSON.parse(String(init?.body)).pointer))) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [["DISCOVERY_ENDPOINT", saved.d], ["METABOB_API_KEY", saved.k]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let seq = 0;
// git_worktree's calls that handed the clone out, one per request that held it, as the walk records each
const handouts = (n: number, out: Record<string, unknown> = CLONE) =>
  Array.from({ length: n }, (_, i) => walkCall(`wt-${i}`, "git_worktree", `sel-${i}`, { ...out }).map((h) => ({ ...h, seq: ++seq }))).flat();
// a refused land's record of where the clone is, as the walk wrote it before it carried every field: no hop beside it
const located = (extra: Record<string, unknown> = {}) => ({ id: `gw-${++seq}`, shape: "gitWorktree", role: "walk", seq, cwd: CWD,
  repo: "concept-db", branch: "dev", base: BASE, head: "4".repeat(40), tree: "3".repeat(40), ...extra });

describe("madeClone, over rows that do not all carry every field", () => {
  it("[MUST-FAIL] fourteen handouts and one refused land's row without origin_url or super_base: one clone, its fields from the rows that carry them", async () => {
    rows = [...handouts(14), located()];
    const { shape: _s, ...made } = CLONE;
    expect(await madeClone(CWD)).toEqual(made);
  });

  it("[GUARD] a field recorded as \"\" is not carried: no second clone, and its value comes from the rows that carry it", async () => {
    rows = [...handouts(14), located({ origin_url: "", super_base: "" })];
    const { shape: _s, ...made } = CLONE;
    expect(await madeClone(CWD)).toEqual(made);
  });

  it("[GUARD] a field no row at the cwd carries leaves the clone unknown: refused", async () => {
    const { origin_url: _o, ...noOrigin } = CLONE;
    rows = [...handouts(3, noOrigin), located()];
    expect(String((await madeClone(CWD) as { error?: string }).error)).toContain("its base, repo, branch or origin");
  });

  it("[GUARD] super_base no row at the cwd carries leaves the clone unknown: refused", async () => {
    const { super_base: _s, ...noSuper } = CLONE;
    rows = [...handouts(3, noSuper), located()];
    expect(String((await madeClone(CWD) as { error?: string }).error)).toContain("its base, repo, branch or origin");
  });

  it("[GUARD] base no row at the cwd carries leaves the clone unknown: refused", async () => {
    const { base: _b, ...noBase } = CLONE;
    const { base: _l, ...unbased } = located();
    rows = [...handouts(3, noBase), unbased];
    expect(String((await madeClone(CWD) as { error?: string }).error)).toContain("its base, repo, branch or origin");
  });

  it("[GUARD] two rows that both carry origin_url and differ are two clones at one place: refused", async () => {
    rows = [...handouts(2), ...handouts(1, { ...CLONE, origin_url: "https://example.invalid/other.git" }), located()];
    expect(String((await madeClone(CWD) as { error?: string }).error)).toContain("walk rows record different clones");
  });

  it("[GUARD] two bases with no refresh between them are two clones at one place: refused", async () => {
    rows = [...handouts(1), located(), ...handouts(1, { ...CLONE, base: "8".repeat(40) })];
    expect(String((await madeClone(CWD) as { error?: string }).error)).toContain("walk rows record different clones");
  });

  it("[MUST-FAIL] a refresh chains to the base before it across a row that carries no base", async () => {
    // in seq order: the clone made, a row of no base, then the refresh (or a second base with none)
    const between = () => { const first = handouts(1); const { base: _b, ...noBase } = located(); return [...first, noBase]; };
    rows = [...between(), ...handouts(1, { ...CLONE, base: "8".repeat(40), refreshed_from: BASE })];
    expect(await madeClone(CWD)).toMatchObject({ base: "8".repeat(40) });
    rows = [...between(), ...handouts(1, { ...CLONE, base: "8".repeat(40) })];
    expect(String((await madeClone(CWD) as { error?: string }).error)).toContain("walk rows record different clones");
  });
});
