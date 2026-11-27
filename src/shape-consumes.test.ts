// shape-consumes — the rows each call takes (SHAPE_CONSUMES), held to the call and to the row: each bound pointer field is
// one the call declares and reads, and each bound row field is one its producer's answer carries through the wrapper.
import { afterAll, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHANGES, SHAPE_ANSWERS, SHAPE_CONSUMES, SHAPE_INPUTS } from "./shape-inputs"
import { WRITE_TOOLS } from "./write-containment"

type Schema = { required: string[]; properties: Record<string, unknown> }

const T = mkdtempSync(join(tmpdir(), "shape-consumes-"))
// Run as root, the tools' git runs as an unprivileged user, which must be able to enter the test directory.
chmodSync(T, 0o755)
afterAll(() => rmSync(T, { recursive: true, force: true }))
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
// A walk clone at its copy's head, so the wrapper runs each call in it, and an address nothing answers for records.
const env = { MITOSIS_PUSH_CLONE_DIR: join(T, "vessels"), WALK_TREES_DIR: join(T, "trees"), DISCOVERY_ENDPOINT: "http://127.0.0.1:9" }
const copy = join(T, "vessels", "demo-vessel")
const clone = join(T, "trees", "demo-vessel-mwabc123-1a2b3c4d")
mkdirSync(copy, { recursive: true }); mkdirSync(join(T, "trees"))
g(copy, "init", "-q", "-b", "dev"); writeFileSync(join(copy, "a.ts"), "1\n2\n3\n"); g(copy, "add", "-A"); g(copy, "commit", "-q", "-m", "base")
g(T, "clone", "-q", copy, clone)
if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", clone])

const tools = async () => {
  Object.assign(process.env, env)
  return (await import("./index")).resolvers
}
const call = async (shape: string, pointer: Record<string, unknown>) =>
  (await (await tools()).get(shape)!({ body: { impulse: { pointer: { type: shape, ...pointer } } } } as never)
    .catch((e: Error) => ({ error: e.message }))) as Record<string, unknown>
const edges = Object.entries(SHAPE_CONSUMES).flatMap(([name, rows]) =>
  rows.flatMap((r) => Object.entries(r.binds ?? {}).map(([field, from]) => ({ name, shape: r.shape, field, from }))))

describe("the rows each call takes", () => {
  // What the walk is shown: the edges as ordered, each a row a step before makes and the field it carries into the next call.
  it("[MUST-FAIL] the declared edges: a read's path into its edit, a clone or a change's cwd into a commit, a commit's into the diff, the diff's into the landing", () => {
    expect(edges.map((e) => `${e.name} ← ${e.shape}.${e.from} as ${e.field}`).sort()).toEqual([
      "code_insert_after_line ← codeReadResult.path as path",
      "code_replace_lines ← codeReadResult.path as path",
      "fs_edit ← fileContent.path as path",
      "git_commit ← codeAddImportResult.cwd as cwd",
      "git_commit ← codeInsertResult.cwd as cwd",
      "git_commit ← codeReplaceResult.cwd as cwd",
      "git_commit ← fileEditResult.cwd as cwd",
      "git_commit ← fileWriteResult.cwd as cwd",
      "git_commit ← gitWorktree.cwd as cwd",
      "git_diff ← gitCommitResult.cwd as cwd",
      "git_land ← gitDiff.cwd as cwd",
    ])
  })

  // A change any write call makes is committed by git_commit: each write call declares its answer, that answer is one of
  // the changes the wrapper names a clone for, and git_commit takes it. A write call added without all three is caught here.
  it("[MUST-FAIL] every write call's answer is a declared change, and git_commit takes each change's cwd", () => {
    const commits = edges.filter((e) => e.name === "git_commit" && e.field === "cwd" && e.from === "cwd").map((e) => e.shape)
    for (const tool of WRITE_TOOLS) {
      const answer = SHAPE_ANSWERS[tool]
      expect(`${tool}: ${answer}`).toMatch(/: [A-Za-z]+Result$/)
      expect(CHANGES.has(answer!)).toBe(true)
      expect(commits).toContain(answer)
    }
    expect(CHANGES.size).toBe(WRITE_TOOLS.length)
  })

  // The walk keeps an answer as a row only when a vessel serving its tool advertises the answer's shape, and a call it can
  // reach only when advertised: an edge from or to either that is not would be shown and never followed.
  it("[MUST-FAIL] each call that takes a row is advertised and served, each row it takes is an advertised answer of a call here, and each field it fills is one it declares", async () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
    const advertised = src.slice(src.indexOf("  shapes: ["), src.indexOf("executor: new ActivityExecutor"))
    expect(src).toContain("shapeConsumes: SHAPE_CONSUMES")
    const resolvers = await tools()
    for (const e of edges) {
      expect(advertised).toContain(`"${e.name}"`)
      expect(resolvers.has(e.name)).toBe(true)
      expect(advertised).toContain(`"${e.shape}"`)
      expect(Object.values(SHAPE_ANSWERS)).toContain(e.shape)
      expect(Object.keys((SHAPE_INPUTS[e.name] as unknown as Schema).properties)).toContain(e.field)
    }
  })

  // Called with the filled field naming a place that does not exist, and the call's other required fields filled, each
  // call's answer names that place: the field is what it works on, not one it ignores.
  it("[MUST-FAIL] each call reads the field a row fills", async () => {
    const sentinel = join(T, "nowhere-zq9", "a.ts")
    const filler: Record<string, unknown> = { old_string: "1", new_string: "one", start_line: 1, end_line: 1, after_line: 0, text: "t", message: "m" }
    for (const e of edges) {
      const schema = SHAPE_INPUTS[e.name] as unknown as Schema
      const pointer = Object.fromEntries(schema.required.filter((f) => f !== e.field).map((f) => [f, filler[f]]))
      const out = await call(e.name, { ...pointer, [e.field]: sentinel })
      expect(`${e.name}.${e.field}: ${JSON.stringify(out)}`).toContain("nowhere-zq9")
    }
  }, 120_000)

  // Each row field filled from is one the producer's answer carries as the walk keeps it: through the wrapper, which adds
  // a change's cwd. Real: made here by the producer in a walk clone, and the pointer field filled from it is what the call
  // needs there, by one predicate per pointer field. Declared: a clone, a commit and a diff need the walk's rows and a
  // landing path to make, so their answers are held to the type each producer declares it answers with.
  const REAL: Record<string, [string, Record<string, unknown>]> = {
    fileContent: ["fs_read", { path: join(clone, "a.ts") }],
    codeReadResult: ["code_read_lines", { path: join(clone, "a.ts"), start_line: 1, end_line: 2 }],
    fileWriteResult: ["fs_write", { path: join(clone, "b.ts"), content: "b\n" }],
    fileEditResult: ["fs_edit", { path: join(clone, "a.ts"), old_string: "1\n", new_string: "one\n" }],
    codeReplaceResult: ["code_replace_lines", { path: join(clone, "a.ts"), start_line: 2, end_line: 2, text: "two" }],
    codeInsertResult: ["code_insert_after_line", { path: join(clone, "a.ts"), after_line: 0, text: "zero" }],
    codeAddImportResult: ["code_add_import", { path: join(clone, "a.ts"), module: "node:fs", specifier: "{ readFileSync }" }],
  }
  // What a call needs in each field a row fills: a commit, a diff and a landing work in the clone, the top of a git
  // worktree; an edit works on a file there that exists.
  const top = (dir: string) => realpathSync(g(dir, "rev-parse", "--show-toplevel"))
  const FILLED: Record<string, (v: unknown) => boolean> = {
    cwd: (v) => v === clone && statSync(v).isDirectory() && top(v) === realpathSync(clone),
    path: (v) => typeof v === "string" && v.startsWith(`${clone}/`) && statSync(v, { throwIfNoEntry: false })?.isFile() === true,
  }
  const DECLARED: Record<string, string> = { gitWorktree: "git-worktree.ts", gitCommitResult: "git-commit.ts", gitDiff: "git-land.ts" }

  it("[MUST-FAIL] each field a row fills gets what the call needs, from the row as its producer answers through the wrapper (real for reads and changes, declared for a clone, a commit and a diff)", async () => {
    for (const e of edges) expect(`${e.shape}: ${e.shape in REAL || e.shape in DECLARED}`).toBe(`${e.shape}: true`)
    const answers = new Map<string, Record<string, unknown>>()
    for (const [shape, [producer, pointer]] of Object.entries(REAL)) {
      const out = await call(producer, pointer)
      expect(`${producer}: ${JSON.stringify(out)}`).toContain(`"shape":"${shape}"`)
      answers.set(shape, out)
    }
    for (const e of edges) {
      expect(`${e.field}: ${e.field in FILLED}`).toBe(`${e.field}: true`)
      if (e.shape in REAL) {
        const pointer = { [e.field]: answers.get(e.shape)![e.from] }
        expect(`${e.name}.${e.field} ← ${e.shape}.${e.from} = ${String(pointer[e.field])}: ${FILLED[e.field]!(pointer[e.field])}`)
          .toBe(`${e.name}.${e.field} ← ${e.shape}.${e.from} = ${String(pointer[e.field])}: true`)
      } else {
        const text = readFileSync(join(import.meta.dir, DECLARED[e.shape]), "utf8")
        const type = text.match(new RegExp(`\\{ shape: "${e.shape}";[^}]*\\}`))?.[0] ?? ""
        expect(`${e.shape}: ${type}`).toMatch(new RegExp(`[;{] ${e.from}: string[;}]`))
      }
    }
  }, 120_000)
})
