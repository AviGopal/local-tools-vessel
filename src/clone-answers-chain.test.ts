// SPDX-License-Identifier: MIT
// Every answer that says where a clone is (its `clone`) becomes a gitWorktree row the walk records, and a later commit or
// landing reads the clone from those rows (walk-rows.ts madeClone): one whose base moved without naming the base it moved
// from reads as a second clone at the same place, and every commit or landing there is refused for good. So each tool that
// runs after the clone is brought onto its copy (clone-refresh.ts freshFirst) is run here for real, in a clone behind its
// copy, its answer's clone recorded as the walk records it, and madeClone must still read one clone, on the new base.
// Throwaway repositories; records is a stub over the rows the walk would hold.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshFirst, madeCurrent } from "./clone-refresh";
import { commitInClone } from "./git-commit";
import { landClone } from "./git-land";
import { makeWorktree } from "./git-worktree";
import { runsOnHeldEdits } from "./shape-inputs";
import { madeClone, type Query, type Row } from "./walk-rows";
import { recordRead, walkCall } from "./walk-call-rows.test-helper";

setDefaultTimeout(120_000);
const T = mkdtempSync(join(tmpdir(), "clone-answers-chain-test-"));
const ENV_KEYS = ["DISCOVERY_ENDPOINT", "METABOB_API_KEY", "SUPER_REPO_DIR", "PULLSYNC_GATE_PUBLIC_DIR", "MITOSIS_PUSH_CLONE_DIR", "MITOSIS_RUNTIME_DIR", "WALK_TREES_DIR",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const asOwner = (cwd: string) => {
  g(cwd, "config", "user.name", "t"); g(cwd, "config", "user.email", "t@t");
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", cwd]);
};
const commitAll = (cwd: string, m: string) => { g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", m); };
const SUPER = join(T, "super");
const ORIGIN = join(T, "demo.git");
const COPY = join(T, "clones", "demo");
const SEED = join(T, "seed");
const realFetch = globalThis.fetch;

// the walk's rows, as records holds them; madeClone and madeCurrent read them through the stub
let walkRows: Array<Record<string, unknown>> = [];
let seq = 0;
// the owner's repository row: demo takes landings on dev
const ownerRows = async (q: Query): Promise<Row[]> => [{ id: "repo-demo", seq: 1, shape: "repository", role: "owner", repo: "demo", branch: "dev" } as Row]
  .filter((r) => (q.shape === undefined || r.shape === q.shape) && Object.entries(q.where ?? {}).every(([k, v]) => String(r[k]) === String(v)));

beforeAll(() => {
  const gate = join(T, "gate-public");
  mkdirSync(gate); writeFileSync(join(gate, "source.json"), JSON.stringify({ schema: 1, gated: false, source: "clone", accepted_sha: null }) + "\n");
  Object.assign(process.env, { DISCOVERY_ENDPOINT: "http://discovery.test", METABOB_API_KEY: "test-node-key", SUPER_REPO_DIR: SUPER, PULLSYNC_GATE_PUBLIC_DIR: gate,
    MITOSIS_PUSH_CLONE_DIR: join(T, "clones"), MITOSIS_RUNTIME_DIR: join(T, "runtime"), WALK_TREES_DIR: join(T, "trees") });
  mkdirSync(join(T, "runtime", "demo"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(T, "runtime", "demo", "node_modules"));
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;
  mkdirSync(join(SUPER, "scripts", "git-hooks"), { recursive: true });
  g(SUPER, "init", "-q", "-b", "dev");
  for (const h of ["pre-commit", "vessel-pre-commit"]) writeFileSync(join(SUPER, "scripts", "git-hooks", h), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", ".gitleaks.toml"), 'title = "t"\n\n[extend]\nuseDefault = true\n');
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: ["scripts/substrate/"] } }) + "\n");
  g(SUPER, "remote", "add", "origin", "https://example.invalid/super.git");
  commitAll(SUPER, "super base");
  g(T, "init", "-q", "--bare", "-b", "dev", ORIGIN);
  g(T, "clone", "-q", ORIGIN, SEED);
  writeFileSync(join(SEED, "a.txt"), "one\n");
  commitAll(SEED, "base"); g(SEED, "push", "-q", "origin", "HEAD:dev");
  mkdirSync(join(T, "clones"));
  g(T, "clone", "-q", "-b", "dev", ORIGIN, COPY);
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => Response.json(recordRead(walkRows, JSON.parse(String(init?.body)).pointer))) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(T, { recursive: true, force: true });
});

/** Origin moves (a push lands) and the node's copy follows: the copy's new HEAD. */
const moveOrigin = (file: string) => {
  g(SEED, "pull", "-q", "origin", "dev"); writeFileSync(join(SEED, file), `${file}\n`); commitAll(SEED, `move ${file}`); g(SEED, "push", "-q", "origin", "HEAD:dev");
  g(COPY, "pull", "-q", "origin", "dev");
  return g(COPY, "rev-parse", "HEAD");
};
/** A clone git_worktree made, as the walk's rows record it (its call's hops), holding a change of its own, then left behind
 *  its copy: committed, or (held) as uncommitted edits. */
const behindClone = async (name: string, held: "committed" | "uncommitted") => {
  const w = await makeWorktree("demo");
  if ("error" in w) throw new Error(w.error);
  walkRows = walkCall(`wt-${name}`, "git_worktree", `sel-${name}`, { ...w }).map((h) => ({ ...h, seq: ++seq }));
  asOwner(w.cwd);
  writeFileSync(join(w.cwd, `${name}.txt`), `${name}\n`);
  if (held === "committed") commitAll(w.cwd, `own ${name}`);
  return { cwd: w.cwd, from: w.base, to: moveOrigin(`origin-${name}.txt`) };
};
/** The answer's clone recorded as the walk records it (walk calls.ts recordRefreshed), then the clone read as a commit reads it. */
const recordedThenRead = async (cwd: string, answer: unknown) => {
  const clone = (answer as { clone?: Record<string, unknown> }).clone;
  expect(clone).toBeDefined();
  walkRows = [...walkRows, { ...clone, id: `gw-${++seq}`, role: "walk", seq, call_id: `call-${seq}` }];
  return madeClone(cwd);
};

// The tools that run after the refresh and answer where the clone is: one that builds its own clone record (git_land, on a
// refusal), and ones whose answer carries the refresh's (git_commit; a read, which says nothing of the clone itself).
const TOOLS: Array<{ name: string; tag: "MUST-FAIL" | "GUARD"; held: "committed" | "uncommitted"; heldEdits: boolean; run: (cwd: string) => Promise<unknown>; said?: string }> = [
  { name: "git_land", tag: "MUST-FAIL", held: "committed", heldEdits: runsOnHeldEdits("git_land"), run: (cwd) => landClone(cwd, { find: (c) => madeCurrent(c), rows: ownerRows, transports: ["file"] }),
    said: "no verdict approves this tree" },
  { name: "git_commit", tag: "GUARD", held: "uncommitted", heldEdits: runsOnHeldEdits("git_commit"), run: (cwd) => commitInClone(cwd, "the edits", undefined, (c) => madeCurrent(c)) },
  { name: "fs_read", tag: "GUARD", held: "committed", heldEdits: runsOnHeldEdits("fs_read"), run: async () => ({ shape: "fileContent" }) },
];
const SCANNER = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });

describe("a clone moved by the call that answers: the answer's record of it leaves one clone", () => {
  for (const t of TOOLS) {
    it(`[${t.tag}] ${t.name}: its answer's clone, recorded after the clone's earlier rows, reads as one clone on the base it was moved to`, async () => {
      const c = await behindClone(t.name.replace("_", "-"), t.held);
      const answer = await freshFirst({ dir: c.cwd, repo: "demo" }, () => t.run(c.cwd), process.env, undefined, t.heldEdits) as Record<string, unknown>;
      // the tool ran past the refresh (git_land refuses on its verdict, past its secrets scan, where a scanner is here)
      if (t.said && SCANNER) expect(String(answer.error)).toContain(t.said);
      expect((answer.clone as { base?: string } | undefined)?.base).toBe(c.to);
      const read = await recordedThenRead(c.cwd, answer);
      expect("error" in read ? read.error : read).toMatchObject({ cwd: c.cwd, base: c.to });
    });
  }
});
