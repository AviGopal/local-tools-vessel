// git_land: push a change clone's commits to its origin, only when an independent verdict approved exactly this tree.
//
// A push to a vessel's origin is an install on every node at the next pull-sync tick, and a leaked secret can never be
// taken back, so nothing the clone says is trusted here: its owner, the shell user, can write its config, refs and
// index. The clone's commits leave it as a bundle the shell user makes (data, no config), and every check runs in a
// fresh repository this vessel owns:
//   - origin's branch is fetched afresh, over https only and with no credential;
//   - the change must fast-forward it, with no merge commits;
//   - the changed paths and which of them need a person are recomputed here (git-commit.ts's answer is advisory);
//   - a secrets scan must run (gitleaks is required: missing, the landing is refused), with the super base's config
//     and inline allow comments ignored. A finding is named by its rule, never its text;
//   - a verdict row must approve this tree: a person's r 1 (records stamps person rows from the person's own key), or,
//     when no path needs a person, a grader's r 1 made from exactly the request and the walk's gitDiff row of this tree.
//     Any grader's r 0 on the tree blocks it unless a person approves.
// Only then is the change pushed: from that repository, no force, with no hooks, and the only command here that
// carries the push credential (the node's system credential helper reads it from this vessel's env).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, judgesOf, vesselGit } from "./git-commit.js";
import { agentShellSpawn, agentWritableDir } from "./shell-privilege.js";
import { type Made, madeClone, type Query, readRows, type Row } from "./walk-rows.js";
import { containmentZones } from "./write-containment.js";

type Run = { stdout: string; stderr: string; exit_code: number };
export type Deps = {
  find: (cwd: string) => Promise<Made | { error: string }>;
  rows: (q: Query) => Promise<Row[] | { error: string }>;
  /** Transports origin may be fetched over; https only, except in a test with a local origin. */
  transports: string[];
};
const DEFAULTS: Deps = { find: madeClone, rows: readRows, transports: ["https"] };

// How long one step here (a git command, the secrets scan, the typecheck) may take before it is stopped and counted as
// not passed.
const STEP_MS = 300_000;

/** git as this vessel, in a repository it owns, with a HOME of its own (no user config) and, unless asked, no credential. */
async function trusted(args: string[], cwd: string, home: string, opts: { credential?: boolean; transports?: string[] } = {}): Promise<Run> {
  const base = opts.credential ? process.env : { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const env = { ...base, HOME: home, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>;
  const allow = (opts.transports ?? []).flatMap((t) => ["-c", `protocol.${t}.allow=always`]);
  const pre = ["-c", "protocol.allow=never", ...allow, ...(opts.credential ? [] : ["-c", "credential.helper="])];
  const p = Bun.spawn(["git", ...pre, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(STEP_MS) });
  const [stdout, stderr, exit_code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exit_code };
}

export type Trusted = {
  repo: string; origin: string; head: string; tree: string;
  out: (args: string[]) => Promise<string | null>;
  step: (args: string[], what: string, opts?: { credential?: boolean; transports?: string[] }) => Promise<Run | { error: string }>;
};

/**
 * The clone's commits since its base, in a fresh bare repository this vessel owns under `work`, beside origin's branch
 * fetched afresh: refs/remotes/origin/<branch> and refs/land/head. The commits leave the clone only as a bundle the
 * shell user writes (data, no config), so nothing of the clone's config, refs or index is read here.
 */
export async function intoTrusted(cwd: string, made: Made, work: string, transports: string[]): Promise<Trusted | { error: string; stderr?: string }> {
  // The shell user must reach the directory handed to it, so `work` can be passed through (not listed or written).
  chmodSync(work, 0o711);
  const drop = agentWritableDir(join(work, "drop"));
  const bundle = join(drop, "change.bundle");
  const b = await git(["bundle", "create", bundle, `${made.base}..HEAD`], cwd);
  if (b.exit_code !== 0) return { error: "the clone's commits could not be bundled", stderr: b.stderr.slice(-500) };
  const repo = join(work, "repo.git");
  const step = async (args: string[], what: string, opts: { credential?: boolean; transports?: string[] } = {}): Promise<Run | { error: string }> => {
    const r = await trusted(args, repo, work, opts);
    return r.exit_code === 0 ? r : { error: `${what} failed`, stderr: r.stderr.slice(-500) } as { error: string };
  };
  const init = await trusted(["init", "--quiet", "--bare", repo], work, work);
  if (init.exit_code !== 0) return { error: "a repository to check the change in could not be made" };
  const origin = `refs/remotes/origin/${made.branch}`;
  for (const [args, what, opts] of [
    [["fetch", "--quiet", made.origin_url, `refs/heads/${made.branch}:${origin}`], `fetching ${made.branch} from origin`, { transports }],
    [["bundle", "verify", bundle], "verifying the bundle", { transports: ["file"] }],
    [["fetch", "--quiet", bundle, "HEAD:refs/land/head"], "reading the bundle", { transports: ["file"] }],
  ] as Array<[string[], string, { transports: string[] }]>) {
    const r = await step(args, what, opts);
    if ("error" in r) return r;
  }
  const out = async (args: string[]) => { const r = await trusted(args, repo, work); return r.exit_code === 0 ? r.stdout.trim() : null; };
  const head = await out(["rev-parse", "refs/land/head"]);
  const tree = await out(["rev-parse", "refs/land/head^{tree}"]);
  if (!head || !tree) return { error: "the bundle carried no commit" };
  return { repo, origin, head, tree, out, step };
}

export type LandResult =
  | { shape: "gitLand"; cwd: string; repo: string; branch: string; head: string; tree: string; changed: string[];
      needs_person: string[]; verdict_ref: string; verdict_by: string; scan: { ran: true; rules: string[] }; pushed: true }
  | { error: string; stderr?: string; rules?: string[]; tree?: string; head?: string; needs_person?: string[] };

export async function landClone(cwd: string, deps: Partial<Deps> = {}): Promise<LandResult> {
  const d = { ...DEFAULTS, ...deps };
  const made = await d.find(cwd);
  if ("error" in made) return made;
  const gitleaks = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });
  if (!gitleaks) return { error: "no secrets scanner (gitleaks) on this node: nothing would stop a leak, so nothing lands" };
  const superDir = containmentZones(process.env).supers[0];
  if (!superDir) return { error: "this node has no super-repo clone: the scan's config cannot be read" };

  const work = mkdtempSync(join(tmpdir(), "land-"));
  try {
    const t = await intoTrusted(cwd, made, work, d.transports);
    if ("error" in t) return t;
    const { repo, origin, head, tree, out } = t;
    if ((await trusted(["merge-base", "--is-ancestor", origin, "refs/land/head"], repo, work)).exit_code !== 0) {
      return { error: `the change does not fast-forward origin's ${made.branch}: it moved since the clone was made` };
    }
    const range = `${origin}..refs/land/head`;
    if (((await out(["rev-list", "--merges", range])) ?? "x") !== "") return { error: "the change holds a merge commit; only a straight line of commits lands" };
    const changed = ((await out(["diff", "--name-only", "--no-renames", origin, "refs/land/head"])) ?? "").split("\n").filter(Boolean);
    if (changed.length === 0) return { error: "nothing to land: the change does not differ from origin" };
    const judges = await judgesOf((path) => out(["show", `${origin}:${path}`]), { repo: made.repo });
    const needs_person = changed.filter((p) => judges.some((g) => new Bun.Glob(g).match(p)));

    // The scan, with the super base's config, over exactly the commits that would be pushed.
    const cfg = await vesselGit(["show", `${made.super_base}:scripts/git-hooks/.gitleaks.toml`], superDir);
    if (cfg.exit_code !== 0) return { error: "the super base has no scan config" };
    writeFileSync(join(work, "gitleaks.toml"), cfg.stdout);
    const report = join(work, "leaks.json");
    const scan = Bun.spawn([gitleaks, "detect", "--source", repo, "--log-opts", range, "--config", join(work, "gitleaks.toml"),
      "--redact", "--no-banner", "--exit-code", "3", "--report-format", "json", "--report-path", report, "--ignore-gitleaks-allow"],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work }, stdout: "ignore", stderr: "ignore", signal: AbortSignal.timeout(STEP_MS) });
    const sc = await scan.exited;
    if (sc === 3) {
      let rules: string[] = [];
      try { rules = [...new Set((JSON.parse(readFileSync(report, "utf8")) as Array<{ RuleID?: string }>).map((f) => String(f.RuleID)))]; } catch { /* unreadable */ }
      return { error: "the secrets scan found something in the change", rules };
    }
    if (sc !== 0) return { error: `the secrets scan did not run cleanly (exit ${sc})` };

    const verdict = await approved(d, made, tree, needs_person);
    if ("error" in verdict) return { ...verdict, tree, needs_person };

    // No hooks run beside the credential: an empty directory this vessel owns.
    const hooksDir = mkdtempSync(join(work, "hooks-"));
    chmodSync(hooksDir, 0o555);
    const push = await t.step(["-c", `core.hooksPath=${hooksDir}`, "push", "--quiet", made.origin_url, `refs/land/head:refs/heads/${made.branch}`],
      "the push", { credential: true, transports: d.transports });
    if ("error" in push) return { ...push, tree, head };
    return { shape: "gitLand", cwd, repo: made.repo, branch: made.branch, head, tree, changed, needs_person, verdict_ref: verdict.id, verdict_by: verdict.by,
      scan: { ran: true, rules: [] }, pushed: true };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir */ }
  }
}

// A request is what a person or the owner asked: an exogenous row that is not a grade and not the owner's configuration.
// Or a gap a detector opened: records refuses a gap row under any key but the node's own, so a gap is the node's own
// observation, trusted as the owner is; a change made for one lands on a grader's verdict only when the gap's own check
// passes on its tree (approved, below). Named debt: these shape and role names are literals here, not read from the
// owner's rows.
const OWNER_CONFIG = new Set(["channel", "shape_schema", "arm", "prior"]);
const isGap = (r: Row): boolean => r.role === "detector" && r.shape === "gap";
const isRequest = (r: Row): boolean =>
  ((r.role === "person" || r.role === "owner") && r.shape !== "outcome" && !OWNER_CONFIG.has(String(r.shape))) || isGap(r);

/** The verdict row that lets this tree land, or why none does. */
// The verdict's writer (records stamps it: a person row's writer is its key id) goes into the answer, so a count of
// autonomous landings can tell a person's approval from an operator agent's key: any key that is not the node's counts as
// a person here.
async function approved(d: Deps, made: Made, tree: string, needsPerson: string[]): Promise<{ id: string; by: string } | { error: string }> {
  const verdicts = await d.rows({ shape: "land_verdict", where: { tree } });
  if (!Array.isArray(verdicts)) return verdicts;
  const mine = verdicts.filter((v) => v.repo === made.repo);
  const diffs = await d.rows({ shape: "gitDiff", where: { tree } });
  if (!Array.isArray(diffs)) return diffs;
  // A person's r 1 counts only when it was given on the walk's own diff of this tree, shown whole: a diff row anyone
  // else wrote could name this tree and show another change.
  const shown = (v: Row): boolean => diffs.some((x) => x.role === "walk" && x.repo === made.repo && x.truncated !== true
    && [v.input_refs].flat().map(String).includes(x.id));
  const person = mine.find((v) => v.role === "person" && Number(v.r) === 1 && shown(v));
  if (person) return { id: person.id, by: String(person.writer ?? "") };
  if (mine.some((v) => v.role === "described" && Number(v.r) === 0)) return { error: "a grader judged this tree r 0, and no person has approved it" };
  if (needsPerson.length > 0) return { error: `the change touches what judges changes (${needsPerson.join(", ")}): only a person's verdict lands it` };
  // A grader's r 1 counts only when it was made from exactly two rows: the request, and the walk's record of this tree's
  // diff made for that request (its input_refs hold the request). Anything more and what it judged is not only the
  // change; anything less and it did not see the change; a diff made for another request is not this request's change.
  for (const v of mine.filter((x) => x.role === "described" && Number(x.r) === 1)) {
    const refs = [...new Set([v.input_refs].flat().map(String))];
    if (refs.length !== 2) continue;
    const diff = diffs.find((x) => x.role === "walk" && x.repo === made.repo && refs.includes(x.id));
    if (!diff) continue;
    // What the grader saw must say the tree typechecks (git_diff's own check of it): a grader told a tree does not
    // compile may still answer r 1, and a diff made before the check existed says nothing.
    if ((diff.typecheck as { passed?: unknown } | undefined)?.passed !== true) continue;
    const asked = await d.rows({ ids: refs.filter((id) => id !== diff.id) });
    if (!Array.isArray(asked)) return asked;
    const request = asked.length === 1 ? asked[0] : undefined;
    if (!request || !isRequest(request)) continue;
    if (![diff.input_refs].flat().map(String).includes(request.id)) continue;
    // A gap's change lands on a grader's verdict only when the gap's own check passed on this tree, for this gap.
    const check = diff.check as { passed?: unknown; gap_id?: unknown } | undefined;
    if (isGap(request) && (check?.passed !== true || String(check.gap_id) !== String(request.gap_id))) continue;
    return { id: v.id, by: String(v.writer ?? "") };
  }
  return { error: "no verdict approves this tree: a person's r 1 on the walk's whole diff of it, or a grader's r 1 from exactly the request and this tree's gitDiff, which says the tree typechecks (and, for a gap, that its check passes)" };
}

// What a grader reads to judge a change: the diff that would land, with the tree it lands as. A diff bigger than this
// is cut and says so, so a grader never judges a part it was not shown as if it were the whole.
const DIFF_MAX = 64 * 1024;

// What the typecheck said, cut like the diff: a grader reads errors, not a whole log.
const CHECK_OUT_MAX = 4 * 1024;

/** Whether the tree typechecks: ran and passed, ran and did not (or ran out of time), or did not run, and why. passed is
 * what git_land reads: true only when the compiler passed, or when the base has no TypeScript config to check by. */
export type Typecheck =
  | { ran: true; passed: boolean; exit_code: number; out: string; truncated: boolean }
  | { ran: false; passed: boolean; why: string };

// What the typecheck reads besides the source: a change to any of these would choose how it is checked, so a tree that
// changes one is not checked under it, and does not pass.
const CHECK_CONFIG = /(^|\/)(tsconfig[^/]*\.json|jsconfig[^/]*\.json|package\.json|bunfig\.toml|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
// What tells the compiler not to check: a directive on a line the change adds, or a declaration file it adds (an
// ambient module declares anything into existence). Such a change passes only by silencing the check, so it does not pass.
const SUPPRESS = /@ts-(nocheck|ignore|expect-error)\b/;
const DECLARATIONS = /\.d\.[cm]?ts$/;

/** The files where a change silences the check: lines it adds with a suppression directive, and declaration files it adds. */
function silenced(patch: string, added: string[]): string[] {
  const out = new Set(added.filter((p) => DECLARATIONS.test(p)));
  let file = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && SUPPRESS.test(line)) out.add(file);
  }
  return [...out].sort();
}

/** The gap a clone was made to fix: its id and the check that says it is fixed (the detector's own). */
export type GapRef = { gap_id: string; test_file: string; only_tests: string[]; lever?: string };

/** Whether that gap's check passes on the tree: the named tests pass when the test file runs alone, as the detector's
 * closer runs it, and no test of the file that passed on the base fails on the tree (regressed names them). passed is
 * what git_land reads; anything that keeps the check from running does not pass. */
export type GapCheck =
  | { gap_id: string; test_file: string; ran: true; passed: boolean; exit_code: number; out: string; truncated: boolean; regressed: string[] }
  | { gap_id?: string; test_file?: string; ran: false; passed: false; why: string };

export type DiffResult =
  | { shape: "gitDiff"; cwd: string; repo: string; base: string; head: string; tree: string; diff: string; truncated: boolean;
      fast_forward: boolean; typecheck: Typecheck; check?: GapCheck }
  | { error: string; stderr?: string };

// What a change could write to make a check it fails read as passing: the runner's own result words, an exit before the
// runner reports, where its report goes. A change adding any of these does not pass the gap's check, whatever else it
// does. A pattern, so it raises the cost of forging a result rather than closing it (the tested code runs in the
// runner's process); the grader and the typecheck stand in front of it.
const FORGES = /\((pass|fail)\)|\bprocess\s*\.\s*(exit|reallyExit|abort|kill)\b|\bBun\s*\.\s*exit\b|\/proc\/self|reporter-outfile|junit/;

/** The tests a junit report says passed, by their "describe > test" names: a test case with no failure, error or skip. */
export function passedIn(xml: string): Set<string> {
  const text = (v: string) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const out = new Set<string>();
  const suites: string[] = [];
  let open: string | null = null;
  let bad = false;
  for (const m of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, self] = m;
    const name = text(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    if (tag === "testsuite") {
      if (close) suites.pop();
      else if (!self) suites.push(name);
    } else if (tag === "testcase") {
      if (close) { if (open !== null && !bad) out.add(open); open = null; continue; }
      // the outermost suite is the file: the name starts at the first describe
      const full = [...suites.slice(1), name].join(" > ");
      if (self) out.add(full);
      else { open = full; bad = false; }
    } else if (!close) bad = true;
  }
  return out;
}

// What a test leans on besides the source it tests: a change to any of these could make the check pass without fixing
// anything, so a tree that changes one does not pass the gap's check.
const TEST_SUPPORT = /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|__mocks__)\/|\.(test|spec)\.[^/]+$/;

/**
 * Whether a path (relative to the repository) is part of a gap's check: its test file, what tests lean on
 * (TEST_SUPPORT) or what chooses how code is checked (CHECK_CONFIG). The one rule for it: git_diff's gap check refuses
 * a change that touches one, and fs_edit refuses the edit itself on a clone made for that gap.
 */
export function isGapCheckFile(path: string, gap: Pick<GapRef, "test_file">): boolean {
  return path === gap.test_file || TEST_SUPPORT.test(path) || CHECK_CONFIG.test(path);
}

/**
 * The gap the call was made for, when its selection's root is a detector's gap: read from records by the selection the
 * walk names on every call (its root is the request the clone is for). No selection: not the walk's call, no gap. A row
 * that cannot be read, or a gap row naming no test file, is an error: the check then does not pass.
 */
export async function gapOf(rows: Deps["rows"], selectionRef: string | undefined): Promise<GapRef | null | { error: string }> {
  if (!selectionRef) return null;
  const sel = await rows({ ids: [selectionRef] });
  if (!Array.isArray(sel)) return sel;
  const root = sel[0]?.root;
  if (typeof root !== "string") return { error: "the call's selection names no root" };
  const r = await rows({ ids: [root] });
  if (!Array.isArray(r)) return r;
  const g = r[0];
  if (!g || g.shape !== "gap" || g.role !== "detector") return null;
  const input = ((g.meta as { evidence_resolve?: { input?: Record<string, unknown> } } | undefined)?.evidence_resolve?.input ?? {});
  if (typeof input.test_file !== "string" || input.test_file === "") return { error: `gap ${String(g.gap_id)} names no test file` };
  // Where the fix belongs, as the gap row says it (meta.sources: what the check imports, which the detector writes):
  // named when an edit of the check itself is refused, so the refusal says where to edit instead.
  const sources = ((g.meta ?? {}) as { sources?: unknown }).sources;
  const lever = Array.isArray(sources) && sources.length > 0 ? sources.map(String).join(", ") : undefined;
  return { gap_id: String(g.gap_id), test_file: input.test_file, only_tests: [input.only_tests ?? []].flat().map(String), ...(lever ? { lever } : {}) };
}

/**
 * Typechecks exactly the tree the diff names, in the same call, so a pass can never belong to another tree: the walk can
 * edit its clone between calls, never inside this one. The check is the base's, never the change's: the tree is
 * compiled under origin's tsconfig.json (none there, nothing to check), and a change to anything that chooses how it is
 * checked (CHECK_CONFIG) does not pass, since otherwise a change could pass by deleting or loosening its own check.
 * Nothing of the clone runs: the tree is written out of the trusted repository by this vessel into a directory of its
 * own, its node_modules (if the change carried one) is replaced by the repository's installed one on this node, and the
 * TypeScript compiler is that install's, run by this vessel's bun. Only the compiler runs as the shell user, with
 * nothing in its env but PATH, so a config that names a file only root may read cannot show it in the row.
 */
async function typecheckTree(t: Trusted, made: Made, dir: string | { why: string }): Promise<Typecheck> {
  const config = await t.out(["show", `${t.origin}:tsconfig.json`]);
  if (config === null) return { ran: false, passed: true, why: "the base has no tsconfig.json: nothing to typecheck" };
  const installed = join(containmentZones(process.env).runtime, made.repo, "node_modules");
  const tsc = join(installed, "typescript", "bin", "tsc");
  if (!existsSync(tsc)) return { ran: false, passed: false, why: `no TypeScript is installed for ${made.repo} on this node` };
  const changed = await t.out(["diff", "--no-renames", "--name-only", t.origin, "refs/land/head"]);
  if (changed === null) return { ran: false, passed: false, why: "the change's paths could not be read" };
  const chosen = changed.split("\n").filter((p) => CHECK_CONFIG.test(p));
  if (chosen.length > 0) return { ran: false, passed: false, why: `the change edits what chooses how it is checked: ${chosen.join(", ")}` };
  const patch = await t.out(["diff", "--no-renames", "--no-ext-diff", "-U0", t.origin, "refs/land/head"]);
  const added = await t.out(["diff", "--no-renames", "--name-only", "--diff-filter=A", t.origin, "refs/land/head"]);
  if (patch === null || added === null) return { ran: false, passed: false, why: "the change's lines could not be read" };
  const quiet = silenced(patch, added.split("\n").filter(Boolean));
  if (quiet.length > 0) return { ran: false, passed: false, why: `the change silences the check in ${quiet.join(", ")}` };
  if (typeof dir !== "string") return { ran: false, passed: false, why: dir.why };
  writeFileSync(join(dir, "tsconfig.json"), config);
  const r = await asShellUser([realpathSync(process.execPath), tsc, "--noEmit", "-p", dir], dir);
  // the compiler's errors lead its output: keep the start
  return { ran: true, passed: r.exit_code === 0 && !r.signalled, exit_code: r.exit_code, out: r.out.slice(0, CHECK_OUT_MAX), truncated: r.out.length > CHECK_OUT_MAX };
}

/** A command run in `dir` as the shell user, env PATH only, within the step time; its output, with dir shown as ".". */
async function asShellUser(argv: string[], dir: string): Promise<{ exit_code: number; signalled: boolean; out: string }> {
  const s = agentShellSpawn(argv, { PATH: process.env.PATH ?? "/usr/bin:/bin" }, tmpdir());
  try {
    const p = Bun.spawn(s.argv, { cwd: dir, env: s.env, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(STEP_MS) });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const out = `${stdout}${stderr}`.split(dir).join(".");
    return { exit_code: typeof code === "number" ? code : -1, signalled: Boolean(p.signalCode), out };
  } finally {
    void s.done();
  }
}

/**
 * The tree, written out of the trusted repository by this vessel into a directory of its own that the shell user can
 * read, with the repository's installed node_modules on this node in place of any the change carried: what both checks
 * run on, so nothing of the clone's is run and nothing it installed is resolved.
 */
async function writeOut(t: Trusted, made: Made, work: string, ref = "refs/land/head", name = "check"): Promise<string | { why: string }> {
  const tar = join(work, `${name}.tar`);
  const a = await trusted(["archive", "--format=tar", "-o", tar, ref], t.repo, work);
  if (a.exit_code !== 0) return { why: "the tree could not be written out" };
  const dir = join(work, name);
  mkdirSync(dir, { mode: 0o755 });
  const x = Bun.spawnSync(["tar", "-xf", tar, "-C", dir, "--no-same-owner"], { stdout: "ignore", stderr: "ignore" });
  if (x.exitCode !== 0) return { why: "the tree could not be written out" };
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  symlinkSync(join(containmentZones(process.env).runtime, made.repo, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/** The gap's test file run alone in a written-out tree as the shell user, judged from the runner's report into a
 * directory made for this run: the tests the report says passed, or null when the run wrote no report. */
async function runCheck(dir: string, testFile: string): Promise<{ passed: Set<string> | null; exit_code: number; signalled: boolean; out: string }> {
  // Judged from the runner's own report, not from its output, which the tested code shares: a run that exits before the
  // runner reports leaves no report, and does not pass.
  const report = join(agentWritableDir(`${dir}-report`), "junit.xml");
  const r = await asShellUser([realpathSync(process.execPath), "test", `./${testFile}`, "--timeout", "20000",
    "--reporter=junit", `--reporter-outfile=${report}`], dir);
  return { ...r, passed: existsSync(report) ? passedIn(readFileSync(report, "utf8")) : null };
}

/**
 * Whether the gap's own check passes on exactly this tree, in the same call: its test file run alone, as the detector's
 * closer runs it, every named test passing and no test of the file that passed on the base failing (a fix that turns a
 * sibling red, a confinement test say, does not pass). The base is run first, in the same call, from origin's branch:
 * when no named test fails there, the gap's check has nothing to tell, so it does not run, and says so. That is all it
 * says of the gap: the closer that closes gaps judges the same file elsewhere, and may still read it red. The base's
 * result is read before anything of the change runs. The check is the base's: a change to its test file, to what tests lean on
 * (TEST_SUPPORT) or to what chooses how code is checked (CHECK_CONFIG) does not pass, so a change cannot pass by editing
 * the check. It runs as the shell user, in the tree written out with the installed node_modules.
 */
async function gapCheck(t: Trusted, dir: string | { why: string }, gap: GapRef | { error: string }, base: string | { why: string }): Promise<GapCheck> {
  if ("error" in gap) return { ran: false, passed: false, why: gap.error };
  const id = { gap_id: gap.gap_id, test_file: gap.test_file };
  if (typeof dir !== "string") return { ...id, ran: false, passed: false, why: dir.why };
  if (typeof base !== "string") return { ...id, ran: false, passed: false, why: base.why };
  const changed = await t.out(["diff", "--no-renames", "--name-only", t.origin, "refs/land/head"]);
  if (changed === null) return { ...id, ran: false, passed: false, why: "the change's paths could not be read" };
  const edits = changed.split("\n").filter((p) => p !== "" && isGapCheckFile(p, gap));
  if (edits.length > 0) return { ...id, ran: false, passed: false, why: `the change edits the check: ${edits.join(", ")}` };
  if (!existsSync(join(dir, gap.test_file))) return { ...id, ran: false, passed: false, why: `${gap.test_file} is not in the tree` };
  const patch = await t.out(["diff", "--no-renames", "--no-ext-diff", "-U0", t.origin, "refs/land/head"]);
  if (patch === null) return { ...id, ran: false, passed: false, why: "the change's lines could not be read" };
  const forged = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++") && FORGES.test(l));
  if (forged.length > 0) return { ...id, ran: false, passed: false, why: `the change writes what the check reads: ${forged[0].slice(1, 200)}` };
  const b = await runCheck(base, gap.test_file);
  if (b.passed === null) return { ...id, ran: false, passed: false, why: "the test run on the base wrote no report" };
  const before = b.passed;
  const red = gap.only_tests.length === 0 ? b.exit_code !== 0 : gap.only_tests.some((n) => !before.has(n));
  if (!red) return { ...id, ran: false, passed: false, why: "the gap's test already passes on the base" };
  const r = await runCheck(dir, gap.test_file);
  const tail = { exit_code: r.exit_code, out: r.out.slice(-CHECK_OUT_MAX), truncated: r.out.length > CHECK_OUT_MAX };
  if (r.passed === null) return { ...id, ran: true, passed: false, ...tail, out: `the test run wrote no report\n${tail.out}`, regressed: [] };
  const passed = r.passed;
  const named = gap.only_tests.length === 0 ? r.exit_code === 0 : gap.only_tests.every((n) => passed.has(n));
  const regressed = [...before].filter((n) => !passed.has(n)).sort();
  return { ...id, ran: true, passed: named && regressed.length === 0 && !r.signalled, ...tail, regressed };
}

// How long each step of a git_diff took, said once per call on this vessel's output (step names and milliseconds only,
// never a path, a name or a diff): a caller that gives up on the call (discovery's forward) sees only that it gave up,
// so this is where the step that overruns is read.
const timed = async <T>(steps: Array<[string, number]>, step: string, f: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try { return await f(); } finally { steps.push([step, Math.round(performance.now() - t0)]); }
};

/** The committed change of a clone git_worktree made, against origin's branch, computed where the clone cannot reach. */
export async function diffClone(cwd: string, made: Made, transports: string[] = DEFAULTS.transports, gap: GapRef | null | { error: string } = null): Promise<DiffResult> {
  const work = mkdtempSync(join(tmpdir(), "diff-"));
  const steps: Array<[string, number]> = [];
  const t0 = performance.now();
  try {
    const t = await timed(steps, "into_trusted", () => intoTrusted(cwd, made, work, transports));
    if ("error" in t) return t;
    const base = await t.out(["rev-parse", t.origin]);
    // The change is what the clone's commits do: diffed from where they leave origin's branch. When origin has moved on
    // since the clone was made, a diff from origin's tip would show every later commit on it undone, as if the change
    // made it (a gate's own tightening shown as loosened). Such a change cannot land as it is (git_land takes a
    // fast-forward only), so it is shown as it is, said not to fast-forward, and checked as not passing: what makes it
    // land is a fresh clone with the edits made again.
    const from = await t.out(["merge-base", t.origin, "refs/land/head"]);
    if (base === null || from === null) return { error: "the change's diff could not be read" };
    const ff = from === base;
    const diff = await timed(steps, "diff", () => t.out(["diff", "--no-renames", from, "refs/land/head"]));
    if (diff === null) return { error: "the change's diff could not be read" };
    const behind = "the clone's base is behind origin's branch: this change cannot land as it is; ask for a fresh clone and make the edits again";
    const dir = ff ? await timed(steps, "write_out", () => writeOut(t, made, work)) : { why: behind };
    const typecheck: Typecheck = ff ? await timed(steps, "typecheck", () => typecheckTree(t, made, dir)) : { ran: false, passed: false, why: behind };
    const baseDir = gap === null || "error" in gap ? { why: "no gap" } : ff ? await timed(steps, "base_out", () => writeOut(t, made, work, t.origin, "base")) : { why: behind };
    const check = gap === null ? {} : { check: await timed(steps, "gap_check", () => gapCheck(t, dir, gap, baseDir)) };
    return { shape: "gitDiff", cwd, repo: made.repo, base, head: t.head, tree: t.tree, diff: diff.slice(0, DIFF_MAX), truncated: diff.length > DIFF_MAX,
      fast_forward: ff, typecheck, ...check };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* a temp dir */ }
    console.log(`[git_diff] ${steps.map(([s, ms]) => `${s}=${ms}ms`).join(" ")} total=${Math.round(performance.now() - t0)}ms`);
  }
}
