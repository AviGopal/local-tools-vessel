// git_worktree makes a clone for one change; git_commit commits in it only when the walk's row says git_worktree made
// it, checked by the super-repo's hooks as of that making, without this vessel's credentials and without a shell.
// Everything runs against throwaway repositories; records is a stub answering the walk's rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInClone, refusedSaying } from "./git-commit";
import { committedTree, makeWorktree } from "./git-worktree";
import { madeClone, type Made } from "./walk-rows";
import { callsRead, episodeRead, recordRead, walkCall } from "./walk-call-rows.test-helper";

// Run as root, git in the code under test drops to the shell user (shell-privilege.ts), which must read these
// fixtures: the test root is opened up, and what hooks write goes to a directory anyone may write.
const T = mkdtempSync(join(tmpdir(), "git-commit-test-"));
chmodSync(T, 0o755);
const OUT = join(T, "out");
mkdirSync(OUT);
chmodSync(OUT, 0o777);
const PAT = "pat-value-that-must-not-reach-a-hook";
const ENV_KEYS = ["DISCOVERY_ENDPOINT", "GITHUB_PUSH_TOKEN", "SUPER_REPO_DIR", "PULLSYNC_GATE_PUBLIC_DIR", "MITOSIS_PUSH_CLONE_DIR", "WALK_TREES_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
// A node gives commits their author from its system git config; a test clone gets one of its own. And what this test
// writes into a clone as itself is handed back to the clone's owner, the shell user when the test runs as root.
const asOwner = (cwd: string) => {
  g(cwd, "config", "user.name", "t"); g(cwd, "config", "user.email", "t@t");
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", cwd]);
};
const commitAll = (cwd: string, m: string) => { g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", m); };

// Each hook records which one ran and the env it ran with, and refuses while a BLOCK file is in the change. One with a
// LEAKY file prints it on stdout and stderr, as a hook printing what it read would, and refuses.
const hook = (name: string, extra = "") =>
  `#!/bin/sh\necho ${name} >> "${OUT}/hooks-ran.txt"\nenv > "${OUT}/hook-env.txt"\n${extra}[ -e BLOCK ] && { echo blocked >&2; exit 1; }\n` +
  `[ -e LEAKY ] && { cat LEAKY; [ -e OLD ] && cat OLD; echo "hook refused: a finding in LEAKY"; cat LEAKY >&2; echo "hook refused on stderr" >&2; exit 1; }\nexit 0\n`;
const SUPER = join(T, "super");
const CLONES = join(T, "clones");
// An ungated node's gate-public marker: a vessel's commit is judged by the list at the super clone's committed HEAD.
const GATE_PUBLIC = join(T, "gate-public");

const made = new Map<string, Made>();
const find = async (cwd: string) => made.get(cwd) ?? { error: `0 walk rows record a clone made at ${cwd}` };
const clone = async (repo: string): Promise<string> => {
  const w = await makeWorktree(repo);
  if ("error" in w) throw new Error(w.error);
  made.set(w.cwd, w);
  asOwner(w.cwd);
  return w.cwd;
};

beforeAll(() => {
  mkdirSync(GATE_PUBLIC);
  writeFileSync(join(GATE_PUBLIC, "source.json"), JSON.stringify({ schema: 1, gated: false, source: "clone", accepted_sha: null }) + "\n");
  Object.assign(process.env, { DISCOVERY_ENDPOINT: "http://discovery.test", GITHUB_PUSH_TOKEN: PAT, SUPER_REPO_DIR: SUPER, PULLSYNC_GATE_PUBLIC_DIR: GATE_PUBLIC, MITOSIS_PUSH_CLONE_DIR: CLONES, WALK_TREES_DIR: join(T, "trees") });
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;
  mkdirSync(join(SUPER, "scripts", "git-hooks"), { recursive: true });
  g(SUPER, "init", "-q", "-b", "dev");
  writeFileSync(join(SUPER, "scripts", "git-hooks", "pre-commit"), hook("super-hook"), { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", "vessel-pre-commit"), hook("vessel-hook", "echo 'note: gitleaks not installed; secrets scan skipped.'\n"), { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", ".gitleaks.toml"), 'title = "t"\n\n[extend]\nuseDefault = true\n');
  // The USER's protected list at the super base: a commit is judged against it (git-land.test.ts covers what it names).
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: ["scripts/substrate/"] } }) + "\n");
  g(SUPER, "remote", "add", "origin", "https://example.invalid/super.git");
  commitAll(SUPER, "super base");
  const demo = join(CLONES, "demo");
  mkdirSync(demo, { recursive: true });
  g(demo, "init", "-q", "-b", "dev");
  writeFileSync(join(demo, "a.txt"), "one\n");
  g(demo, "remote", "add", "origin", "https://example.invalid/demo.git");
  commitAll(demo, "demo base");
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  globalThis.fetch = realFetch;
  rmSync(T, { recursive: true, force: true });
});

describe("git_worktree", () => {
  it("clones this node's copy for one change, at its HEAD, with that copy's origin", async () => {
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    expect(w.cwd.startsWith(join(T, "trees"))).toBe(true);
    expect(w.base).toBe(g(join(CLONES, "demo"), "rev-parse", "HEAD"));
    expect(w.super_base).toBe(g(SUPER, "rev-parse", "HEAD"));
    expect(w.origin_url).toBe("https://example.invalid/demo.git");
    expect(w.branch).toBe("dev");
    expect(g(w.cwd, "config", "--get", "remote.origin.url")).toBe("https://example.invalid/demo.git");
    expect(readFileSync(join(w.cwd, "a.txt"), "utf8")).toBe("one\n");
  });

  // records, stubbed as records answers: selections name their request (root, and the root in pool_refs, which is how
  // records' episode finds them), and the walk's hops carry its writer. It counts the bytes it sends.
  const stubRecords = () => {
    const rows: Array<Record<string, unknown>> = [];
    const st = { open: [] as string[], down: false, bytes: 0, reads: [] as string[] };
    const sel = (id: string, root: string) => rows.push({ id, shape: "selection", role: "walk", writer: "walk-1", root, pool_refs: [root], cands: "x".repeat(40_000) });
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.headers as Record<string, string> | undefined)?.Authorization !== "ApiKey test-node-key") return new Response("no key", { status: 401 });
      if (st.down) return new Response("down", { status: 503 });
      const p = JSON.parse(String(init?.body)).pointer;
      st.reads.push(JSON.stringify({ ...p, type: undefined }));
      const body = p.episode !== undefined && Array.isArray(p.calls) ? callsRead(rows, st.open, p.calls)
        : p.episode !== undefined ? episodeRead(rows, String(p.episode), st.open)
        : p.shape === "arm" ? [{ id: "arm-1", shape: "arm", role: "owner", vessel_id: "walk-1" }]
        : recordRead(rows, p);
      const text = JSON.stringify(body);
      st.bytes += text.length;
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    // The selection is passed as the walk's call names it: a git_worktree that read it to choose a clone would hand one out.
    const ask = async (s?: string) => {
      const w = await (makeWorktree as (repo: string, env: NodeJS.ProcessEnv, sel?: string) => ReturnType<typeof makeWorktree>)("demo", process.env, s);
      if ("error" in w) throw new Error(w.error);
      // the walk records the whole answer in its ended hop
      if (s) rows.push(...walkCall(String(rows.length), "git_worktree", s, { ...w }).map((h) => ({ ...h, writer: "walk-1", seq: rows.length + 1 })));
      return w;
    };
    return { rows, st, sel, ask };
  };

  // Law 6: every call makes a new clone. A clone handed out again, or moved onto a newer base, is reuse coming back.
  it("[MUST-FAIL] every call makes a new clone: the same open request asking twice, and a request after one closed, never get one handed out before", async () => {
    const trees = join(T, "trees");
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    for (const [id, root] of [["sel-a", "R-A"], ["sel-a2", "R-A"], ["sel-c", "R-C"]]) sel(id, root);
    st.open = ["R-A", "R-C"];
    const before = readdirSync(trees).length;
    const a = (await ask("sel-a")).cwd;
    const a2 = (await ask("sel-a2")).cwd;
    st.open = ["R-C"]; // R-A closes: its clones are unchanged, and still go to no one
    const c = (await ask("sel-c")).cwd;
    expect(new Set([a, a2, c]).size).toBe(3);
    expect(readdirSync(trees).length).toBe(before + 3);
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] no answer of git_worktree carries refreshed_from, carried or not_carried: once the copy has moved on, a request asking again gets a new clone at the new tip, and its old one stays as it was", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-e", "R-E"], ["sel-e2", "R-E"], ["sel-f", "R-F"], ["sel-f2", "R-F"]]) sel(id, root);
    st.open = ["R-E", "R-F"];
    const e = await ask("sel-e"); // changed, then left behind
    writeFileSync(join(e.cwd, "edit.txt"), "x\n");
    const f = await ask("sel-f"); // unchanged, then left behind
    writeFileSync(join(demo, "b.txt"), "two\n");
    commitAll(demo, "a push landed");
    const tip = g(demo, "rev-parse", "HEAD");
    const answers = [e, f, await ask("sel-e2"), await ask("sel-f2")] as unknown as Array<Record<string, unknown>>;
    for (const a of answers) expect(["refreshed_from", "carried", "not_carried"].filter((k) => k in a)).toEqual([]);
    const [e2, f2] = answers.slice(2) as unknown as Array<{ cwd: string; base: string }>;
    expect([e2.cwd === e.cwd, f2.cwd === f.cwd, e2.base, f2.base]).toEqual([false, false, tip, tip]);
    expect([g(e.cwd, "rev-parse", "HEAD"), g(f.cwd, "rev-parse", "HEAD")]).toEqual([e.base, f.base]);
    expect(readFileSync(join(e.cwd, "edit.txt"), "utf8")).toBe("x\n");
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] a fresh clone says its committed tree, and no tree", async () => {
    const w = await makeWorktree("demo") as unknown as Record<string, unknown>;
    expect(w.committed_tree).toBe(g(String(w.cwd), "rev-parse", "HEAD^{tree}"));
    expect("tree" in w).toBe(false);
  });

  it("refuses a name that is not a repo's, and a repo this node has no copy of", async () => {
    expect("error" in (await makeWorktree("../etc"))).toBe(true);
    expect(String((await makeWorktree("no-such-vessel") as { error: string }).error)).toContain("no copy");
  });
});

describe("git_commit", () => {
  it("[MUST-FAIL] commits a message as written: $(...) and backticks are never run", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "two\n");
    const message = "fix: say $(touch PWNED) and `touch PWNED2`";
    const r = await commitInClone(cwd, message, undefined, find);
    expect("sha" in r).toBe(true);
    expect(g(cwd, "log", "-1", "--format=%B")).toBe(message);
    expect("cwd" in r && r.cwd).toBe(cwd); // the clone it is in, for an owner row to bind a call's cwd to
    expect(existsSync(join(cwd, "PWNED")) || existsSync(join(cwd, "PWNED2")) || existsSync(join(T, "PWNED"))).toBe(false);
  });

  it("[MUST-FAIL] runs the super-repo's hook, not one the change sets up: a weakened hook in the clone does not run", async () => {
    const cwd = await clone("demo");
    mkdirSync(join(cwd, ".git-hooks"));
    writeFileSync(join(cwd, ".git-hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    g(cwd, "config", "core.hooksPath", ".git-hooks");
    asOwner(cwd);
    writeFileSync(join(cwd, "BLOCK"), "x\n");
    const r = await commitInClone(cwd, "weaken the gate", undefined, find);
    expect("error" in r && r.error).toContain("refused");
    // what the hook said is kept only when it could be scanned; with no scanner on the node it is withheld
    if (Bun.which("gitleaks")) expect("stderr" in r && r.stderr).toContain("blocked");
    else expect("stderr_withheld" in r && r.stderr_withheld).toContain("no secrets scanner");
  });

  // Key-shaped values, built so that no scanner reads this file as holding one.
  const ADDED = "AKIA" + "Z7Q4LX2M9WB3N8PD";
  const IN_TREE = "AKIA" + "Q2W8E4R6T1Y3U5I7";
  const refuse = async (leaky: string, opts: { old?: string; scanner?: string | null } = {}) => {
    if (opts.old !== undefined) { writeFileSync(join(CLONES, "demo", "OLD"), opts.old); commitAll(join(CLONES, "demo"), "a file already in the tree"); }
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "LEAKY"), leaky);
    const r = await commitInClone(cwd, "plant a value", undefined, find, opts.scanner === undefined ? Bun.which("gitleaks") : opts.scanner);
    if (opts.old !== undefined) { rmSync(join(CLONES, "demo", "OLD")); commitAll(join(CLONES, "demo"), "the file gone again"); }
    expect("error" in r && r.error).toContain("refused");
    return r as { stderr?: string; stderr_withheld?: string };
  };
  // A scanner that names one line, whatever it is given, and always finds it: line 0 is past nothing, a large one past the end.
  const stub = (line: number): string => {
    const at = join(T, `stub-scanner-${line}`);
    writeFileSync(at, `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "--report-path" ] && R="$2"; shift; done\n` +
      `printf '[{"RuleID":"stub","StartLine":${line},"EndLine":${line}}]' > "$R"\nexit 3\n`, { mode: 0o755 });
    return at;
  };

  it("the secrets scanner these tests need is on PATH: without it the redaction tests would prove nothing", () => {
    expect(Bun.which("gitleaks")).not.toBeNull();
  });

  it("[MUST-FAIL] a commit says its tree as committed_tree too, the name a clean clone's answer gives it", async () => {
    const cwd = await clone("demo")
    writeFileSync(join(cwd, "a.txt"), "committed tree\n")
    const r = await commitInClone(cwd, "fix: committed tree", undefined, find) as unknown as Record<string, unknown>
    expect([r.committed_tree, r.tree]).toEqual([g(cwd, "rev-parse", "HEAD^{tree}"), g(cwd, "rev-parse", "HEAD^{tree}")])
  })

  it("[MUST-FAIL] a tree the clone already committed is nothing new, said with that commit, not as a refusal", async () => {
    const cwd = await clone("demo")
    writeFileSync(join(cwd, "a.txt"), "changed once\n")
    const first = await commitInClone(cwd, "fix: once", undefined, find)
    expect("sha" in first).toBe(true)
    const again = await commitInClone(cwd, "fix: once more", undefined, find)
    expect("error" in again && again.error).toContain("nothing new to commit")
    expect(["error" in again && again.head, "error" in again && again.error.includes((first as { sha: string }).sha)]).toEqual([(first as { sha: string }).sha, true])
    // and says the commit still has to land: the remote, as this clone saw it, does not hold it (eb1768f6: committed at
    // 09:53, never landed, and told at 15:36 only that "the pinned hook, or git" refused)
    expect("error" in again && again.error).toContain("the remote does not hold it, as this clone last saw it: land it")
  })

  it("[MUST-FAIL] what a refusal says carries git's own words from its stdout, after the hook's from its stderr (deployment L5)", async () => {
    // git says "nothing to commit" on its stdout; the checks before git now catch that case, so it is fed here directly
    const cwd = await clone("demo")
    const m = await find(cwd)
    if ("error" in m) throw new Error(m.error)
    const said = await refusedSaying({ stdout: "nothing to commit, working tree clean\n", stderr: "hook: checked\n", exit_code: 1 }, SUPER, m, Bun.which("gitleaks"))
    const text = "stderr" in said ? said.stderr : ""
    expect([text.includes("nothing to commit, working tree clean"), text.indexOf("hook: checked") < text.indexOf("nothing to commit")]).toEqual([true, true])
  })

  it("[MUST-FAIL] a commit git refuses for its own reason is said as git's, with git's words, never blamed on the hook", async () => {
    const cwd = await clone("demo")
    writeFileSync(join(cwd, "a.txt"), "changed\n")
    const r = await commitInClone(cwd, "", undefined, find) // git refuses an empty message itself
    expect("error" in r && r.error).toBe("the commit was refused by git (not the hook): see what it said")
    expect((r as { stderr?: string }).stderr ?? "").toContain("empty commit message")
  })

  it("[MUST-FAIL] a refused commit says what the hook printed (its stdout and stderr both), cut short, without a key the change added", async () => {
    const r = await refuse(`${"x".repeat(5000)}\naws_key=${ADDED}\nshort=abc\n`);
    const said = r.stderr ?? "";
    expect(said.length).toBeLessThanOrEqual(2000);
    expect(said).not.toContain(ADDED);
    expect(said).toContain("[REDACTED: secrets scan, rules aws-access-token]");
    expect(said).toContain("short=abc");
    expect(said).toContain("hook refused on stderr"); // the end of what it printed: where a hook gives its verdict
  });

  it("[MUST-FAIL] a key in a file already in the tree, printed by the hook, is not in the answer", async () => {
    const r = await refuse("a line\n", { old: `old_key=${IN_TREE}\n` });
    expect(r.stderr ?? "").not.toContain(IN_TREE);
    expect(r.stderr).toContain("[REDACTED: secrets scan");
  });

  it("[MUST-FAIL] any value this vessel holds that an agent's shell is not given, printed by the hook, is not in the answer", async () => {
    // a name no list carries: what is withheld from the shell is what is redacted here, whatever it is called
    const name = "SOME_PROVIDER_" + "SECRET_OF_THIS_TEST";
    const own = "node-credential-value-" + "4f1c9a7e2b";
    process.env[name] = own;
    try {
      const r = await refuse(`the key is ${own} here\n`);
      expect(r.stderr ?? "").not.toContain(own);
      expect(r.stderr).toContain("[REDACTED]");
    } finally { delete process.env[name]; }
  });

  it("[MUST-FAIL] a value that is a place (a path, a URL without credentials) keeps a failure's file and line; a token beside it does not stay", async () => {
    const set: Record<string, string> = {
      ["WORK" + "SPACE_ROOT_OF_THIS_TEST"]: "/workspace",
      ["SHELL_" + "OF_THIS_TEST"]: "/bin/bash",
      ["ENDPOINT_" + "OF_THIS_TEST"]: "http://127.0.0.1:8100",
      ["TOKEN_" + "OF_THIS_TEST"]: "tok-" + "9b2e7c41d0a8f6",
      ["CRED_URL_" + "OF_THIS_TEST"]: "https://" + "user:pw-" + "77aa31c9@example.invalid/x",
      ["QUERY_URL_" + "OF_THIS_TEST"]: "https://h/x?token=" + "q-5d0e9a2b7c13",
      ["HOOK_URL_" + "OF_THIS_TEST"]: "https://hooks.example/services/T0/B0/" + "w3bh00k5ecr3tT0k3nAbCdEf",
    };
    Object.assign(process.env, set);
    try {
      const failing = "src/x.ts(12,3): error TS2304: Cannot find name 'y' at /workspace/git/walk-trees/t/src/x.ts:12 via /bin/bash http://127.0.0.1:8100/health";
      const r = await refuse(`${failing}\nwith ${set["TOKEN_" + "OF_THIS_TEST"]} and pw-77aa31c9 and q-5d0e9a2b7c13 and ${set["HOOK_URL_" + "OF_THIS_TEST"]}\n`);
      expect(r.stderr).toContain("/workspace/git/walk-trees/t/src/x.ts:12");
      expect(r.stderr).toContain("/bin/bash");
      expect(r.stderr).toContain("http://127.0.0.1:8100/health");
      expect(r.stderr ?? "").not.toContain("9b2e7c41d0a8f6");
      expect(r.stderr ?? "").not.toContain("pw-77aa31c9");
      expect(r.stderr ?? "").not.toContain("q-5d0e9a2b7c13");
      expect(r.stderr ?? "").not.toContain("w3bh00k5ecr3tT0k3nAbCdEf"); // a webhook's secret rides in its path
    } finally { for (const k of Object.keys(set)) delete process.env[k]; }
  });

  it("[MUST-FAIL] a finding the scan places outside the text withholds everything", async () => {
    const r = await refuse(`aws_key=${ADDED}\n`, { scanner: stub(9999) });
    expect(r.stderr).toBeUndefined();
    expect(r.stderr_withheld).toContain("could not place");
  });

  it("[MUST-FAIL] a finding the scan places on the wrong line is caught by scanning the replaced text again: withheld", async () => {
    // the stub names line 1 every time; the key the hook prints is on a later line, so it survives the first replace
    const r = await refuse(`first line\naws_key=${ADDED}\n`, { scanner: stub(1) });
    expect(r.stderr).toBeUndefined();
    expect(r.stderr_withheld).toContain("still found");
    expect(JSON.stringify(r)).not.toContain(ADDED);
  });

  it("[MUST-FAIL] a long name the change added stays readable, and both of the hook's streams are said", async () => {
    const r = await refuse("const someVeryLongIdentifierName = 1\nsrc/a.ts(3,1): error TS2304: Cannot find name 'someVeryLongIdentifierName'.\n");
    expect(r.stderr).toContain("Cannot find name 'someVeryLongIdentifierName'");
    expect(r.stderr).toContain("hook refused: a finding in LEAKY"); // what the hook printed on its stdout
    expect(r.stderr).toContain("hook refused on stderr"); // and on its stderr
  });

  it("[MUST-FAIL] when the scan cannot run, nothing the hook printed is kept: it is withheld and said why", async () => {
    // none on the node; one that cannot start; one that runs and fails (exits 1, neither clean nor a finding)
    for (const scanner of [null, "/nonexistent/gitleaks", "/bin/false"]) {
      const r = await refuse(`aws_key=${ADDED}\n`, { scanner });
      expect(r.stderr).toBeUndefined();
      expect(typeof r.stderr_withheld).toBe("string");
      expect(JSON.stringify(r)).not.toContain(ADDED);
    }
  });

  it("[MUST-FAIL] the commit and its hook run without this vessel's credentials", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "three\n");
    expect("sha" in (await commitInClone(cwd, "an ordinary change", undefined, find))).toBe(true);
    const seen = readFileSync(join(OUT, "hook-env.txt"), "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).not.toContain(PAT);
    expect(seen).not.toContain("GITHUB_PUSH_TOKEN");
  });

  it("[MUST-FAIL] takes the base from the walk's row: a commit slipped into the clone is still judged", async () => {
    const cwd = await clone("demo");
    mkdirSync(join(cwd, "scripts", "substrate", "gate"), { recursive: true });
    writeFileSync(join(cwd, "scripts", "substrate", "gate", "x.sh"), "x\n");
    commitAll(cwd, "slipped in by hand"); // the clone's own HEAD now carries the gate change
    asOwner(cwd)
    writeFileSync(join(cwd, "a.txt"), "four\n");
    const r = await commitInClone(cwd, "an ordinary-looking change", undefined, find);
    if (!("sha" in r)) throw new Error(JSON.stringify(r));
    expect(r.base).toBe(made.get(cwd)!.base);
    expect(r.changed.sort()).toEqual(["a.txt", "scripts/substrate/gate/x.sh"]);
    expect("needs_person" in r).toBe(false); // no path waits on a person
    expect(r.tree).toBe(g(cwd, "rev-parse", "HEAD^{tree}"));
  });

  it("[MUST-FAIL] a clone no walk row names, rows naming different clones there, or one that has landed, is refused", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "five\n");
    // the walk's call rows, as the walk writes them (started names the shape; ended carries the output, not the shape)
    const call = (n: string, type: string, output: object, extra: Record<string, unknown> = {}) =>
      walkCall(n, type, `sel-${n}`, output as Record<string, unknown>).map((r) => ({ ...r, ...extra }));
    const answer = (rows: Array<Record<string, unknown>>) => {
      globalThis.fetch = (async (_u: unknown, init?: RequestInit) => Response.json(recordRead(rows, JSON.parse(String(init?.body)).pointer))) as typeof fetch;
    };
    const w = made.get(cwd)!;
    answer([]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("no walk row");
    answer([...call("1", "git_worktree", w), ...call("2", "git_worktree", { ...w, base: "0".repeat(40) })]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("2 walk rows record different clones");
    answer(call("1", "git_worktree", w, { role: "person" }));
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("no walk row");
    // a clone's base never moves: a second base is a second clone, whatever base a row says it came from
    answer([...call("1", "git_worktree", w, { seq: 1 }), ...call("2", "git_worktree", { ...w, base: "1".repeat(40), refreshed_from: w.base }, { seq: 2 })]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("different clones");
    // rows that agree (a refused landing's record beside the clone's own) read as one, the later one's super_base holding
    answer([...call("1", "git_worktree", w, { seq: 1 }), ...call("2", "git_worktree", { ...w, super_base: "f".repeat(40) }, { seq: 2 })]);
    expect(await madeClone(cwd)).toEqual({ cwd, repo: "demo", branch: "dev", base: w.base, super_base: "f".repeat(40), origin_url: w.origin_url });
    answer([...call("1", "git_worktree", w), ...call("3", "git_land", { cwd })]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("already landed");
    delete process.env.DISCOVERY_ENDPOINT;
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("no discovery endpoint");
    process.env.DISCOVERY_ENDPOINT = "http://discovery.test";
    answer(call("1", "git_worktree", w));
    expect(await madeClone(cwd)).toEqual({ cwd, repo: "demo", branch: "dev", base: w.base, super_base: w.super_base, origin_url: w.origin_url });
    globalThis.fetch = realFetch;
    expect(String((await commitInClone(join(T, "not-made"), "x", undefined, find) as { error: string }).error)).toContain("0 walk rows");
  });

  it("a vessel change runs the vessel hook and a super-repo change the super hook; a skipped secrets scan is reported", async () => {
    const before = existsSync(join(OUT, "hooks-ran.txt")) ? readFileSync(join(OUT, "hooks-ran.txt"), "utf8").split("\n").length : 1;
    const v = await clone("demo");
    writeFileSync(join(v, "a.txt"), "six\n");
    const rv = await commitInClone(v, "vessel change", undefined, find);
    const s = await clone("super");
    writeFileSync(join(s, "README.md"), "x\n");
    const rs = await commitInClone(s, "super change", undefined, find);
    const ran = readFileSync(join(OUT, "hooks-ran.txt"), "utf8").split("\n").slice(before - 1).filter(Boolean);
    expect(ran).toEqual(["vessel-hook", "super-hook"]);
    expect("scan" in rv && rv.scan).toBe("skipped");
    expect("scan" in rs && rs.scan).toBe("ran");
  });

  // The super-repo hook reads its scan config from beside itself, as the real one does: missing, the scan cannot run,
  // and the real hook reports that as secrets found. Each case swaps the super base's hook and puts the fixture's back.
  const withSuperHook = async (text: string, fn: () => Promise<void>) => {
    const path = join(SUPER, "scripts", "git-hooks", "pre-commit");
    const keep = readFileSync(path, "utf8");
    writeFileSync(path, text, { mode: 0o755 }); commitAll(SUPER, "super hook for a case");
    try { await fn(); } finally { writeFileSync(path, keep, { mode: 0o755 }); commitAll(SUPER, "fixture hook back"); }
  };

  it("[MUST-FAIL] the super hook finds its scan config beside it, so a clean super commit is not refused as a leak", async () => {
    await withSuperHook('#!/bin/sh\n[ -f "$(dirname "$0")/.gitleaks.toml" ] || { echo "gitleaks: secrets detected in staged diff"; exit 1; }\nexit 0\n', async () => {
      const s = await clone("super");
      writeFileSync(join(s, "clean.md"), "nothing secret\n");
      const r = await commitInClone(s, "clean super change", undefined, find);
      expect("sha" in r ? "committed" : JSON.stringify(r)).toBe("committed");
    });
  });

  const SCANNER = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });
  it(SCANNER ? "[MUST-FAIL] a real secret in a super commit is still refused by the pinned hook's scan"
    : "[MUST-FAIL] a real secret in a super commit is still refused (no gitleaks here: not run)", async () => {
    if (!SCANNER) return;
    // The fixture's config at the super base has no project rule; the scan uses gitleaks' default rules beside it.
    await withSuperHook('#!/bin/sh\ngitleaks protect --staged --redact --no-banner --config "$(dirname "$0")/.gitleaks.toml" >/dev/null 2>&1 || { echo "gitleaks: secrets detected in staged diff"; exit 1; }\nexit 0\n', async () => {
      const s = await clone("super");
      const secret = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8S9t0"].join("");
      writeFileSync(join(s, "leak.env"), `TOKEN=${secret}\n`);
      const r = await commitInClone(s, "a leak", undefined, find);
      expect("error" in r && String(r.error)).toContain("refused");
    });
  });

  // The super-repo's real hook (test/fixtures/super-hooks/pre-commit, copied byte for byte), pinned from the super base:
  // its placement rule decides a super commit, whatever the clone says of its own copy.
  const REAL_HOOK = readFileSync(join(import.meta.dir, "..", "test", "fixtures", "super-hooks", "pre-commit"), "utf8");
  it("[GUARD] the super base's hook refuses a file outside the allowed top-level directories, saying why, though the clone rewrote its own copy", async () => {
    await withSuperHook(REAL_HOOK, async () => {
      const s = await clone("super");
      mkdirSync(join(s, "newtop"));
      writeFileSync(join(s, "newtop", "x.md"), "misplaced\n");
      mkdirSync(join(s, "scripts", "git-hooks"), { recursive: true });
      writeFileSync(join(s, "scripts", "git-hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      g(s, "config", "core.hooksPath", "scripts/git-hooks");
      asOwner(s);
      const r = await commitInClone(s, "a new top-level directory", undefined, find) as { error: string; stderr?: string; stderr_withheld?: string };
      expect(r.error).toBe("the commit was refused (the pinned hook, or git)");
      if (Bun.which("gitleaks")) expect(r.stderr).toContain("new file in unrecognised top-level directory");
      expect(g(s, "rev-parse", "HEAD")).toBe(String(made.get(s)?.base));
    });
  });

  it("a docs/ file commits under the super base's hook (the control)", async () => {
    await withSuperHook(REAL_HOOK, async () => {
      const s = await clone("super");
      mkdirSync(join(s, "docs"), { recursive: true });
      writeFileSync(join(s, "docs", "placed.md"), "placed\n");
      const r = await commitInClone(s, "a doc", undefined, find);
      expect("sha" in r ? "committed" : JSON.stringify(r)).toBe("committed");
    });
  });

  it("[MUST-FAIL] keeps the node's record-only hooks, but never its pre-commit, which would chain to the clone's own", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "ledger-hooks-"));
    writeFileSync(join(ledger, "post-commit"), `#!/bin/sh\necho recorded >> "${OUT}/ledger.txt"\n`, { mode: 0o755 });
    writeFileSync(join(ledger, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const sys = join(T, "gitconfig-system");
    writeFileSync(sys, `[core]\n\thooksPath = ${ledger}\n`);
    const keep = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_SYSTEM = sys;
    try {
      const cwd = await clone("demo");
      writeFileSync(join(cwd, "a.txt"), "eight\n");
      expect("sha" in (await commitInClone(cwd, "recorded", undefined, find))).toBe(true);
      expect(readFileSync(join(OUT, "ledger.txt"), "utf8")).toContain("recorded");
      writeFileSync(join(cwd, "BLOCK"), "x\n"); // the ledger's permissive pre-commit must not replace the super-repo's
      expect("error" in (await commitInClone(cwd, "blocked", undefined, find))).toBe(true);
    } finally {
      if (keep === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = keep;
      rmSync(ledger, { recursive: true, force: true });
    }
  });

  it("leaves no pinned hook directory behind, and refuses a clone with nothing changed", async () => {
    const pinned = () => readdirSync(tmpdir()).filter((n) => n.startsWith("pinned-hooks-")).length;
    const before = pinned();
    const cwd = await clone("demo");
    // a fresh clone (HEAD is its base) with nothing changed is said as such, never as a commit already made (deployment)
    expect(String((await commitInClone(cwd, "nothing", undefined, find) as { error: string }).error)).toBe("nothing to commit: the clone does not differ from its base");
    writeFileSync(join(cwd, "a.txt"), "seven\n");
    await commitInClone(cwd, "something", undefined, find);
    expect(pinned()).toBe(before);
  });
});

// committed_tree is what a diff waits on, so a clone git cannot read says none: never "", never git's echo of its
// argument, never a tree for a clone whose state is unknown.
describe("committedTree: a clone git cannot read says no committed tree", () => {
  it("[MUST-FAIL] a clone with no commit yet (HEAD's tree unreadable), clean, says none", async () => {
    const cwd = join(T, "unborn");
    mkdirSync(cwd, { recursive: true });
    g(cwd, "init", "-q");
    asOwner(cwd);
    expect(await committedTree(cwd)).toEqual({});
  });

  it("[MUST-FAIL] a clone whose index git cannot read (status fails) says none, though HEAD's tree reads", async () => {
    const cwd = join(T, "bad-index");
    mkdirSync(cwd, { recursive: true });
    g(cwd, "init", "-q");
    asOwner(cwd);
    writeFileSync(join(cwd, "a.txt"), "a\n"); commitAll(cwd, "one commit"); asOwner(cwd);
    expect(await committedTree(cwd)).toEqual({ committed_tree: g(cwd, "rev-parse", "HEAD^{tree}") });
    writeFileSync(join(cwd, ".git", "index"), "not an index");
    asOwner(cwd);
    expect(() => g(cwd, "status", "--porcelain")).toThrow(/index/);
    expect(await committedTree(cwd)).toEqual({});
  });
});
