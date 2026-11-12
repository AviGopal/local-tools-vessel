// Pins each declared input schema (shape-inputs.ts) to its handler: every handler, called with exactly the required
// fields its schema declares, gets past its own "is required" check. A handler edited to need another field without
// its schema following turns this red, so what discovery tells the walk to send stays what the handler reads.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolvers } from "./index"
import { SHAPE_ANSWERS, SHAPE_DESCRIPTIONS, SHAPE_INPUTS } from "./shape-inputs"

type Schema = { required: string[]; properties: Record<string, { type?: string }> }

// A file under tmp (a tool root) with three lines, and a value for every field a schema can require.
const dir = mkdtempSync(join(tmpdir(), "shape-inputs-"))
// Every handler is called below, walk_trees_reclaim among them, which removes clones. Its clones directory and the
// records it decides from are pointed at a temporary directory and an address nothing answers, so this file can never
// reach a node's live clones, whatever environment it runs in.
process.env.WALK_TREES_DIR = join(dir, "walk-trees")
process.env.DISCOVERY_ENDPOINT = "http://127.0.0.1:9"
const sample = (field: string): unknown => {
  const file = join(dir, `f-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(file, "line1\nline2\nline3\n")
  const values: Record<string, unknown> = {
    path: file, content: "x", old_string: "line1", new_string: "LINE1", start_line: 1, end_line: 2, text: "t",
    after_line: 0, pattern: "line", cwd: dir, command: "true", message: "m", repo: "no-such-repo",
  }
  if (!(field in values)) throw new Error(`no sample for required field ${field}: add one`)
  return values[field]
}
const call = (shape: string, pointer: Record<string, unknown>) =>
  resolvers.get(shape)!({ body: { impulse: { pointer: { type: shape, ...pointer } } } } as never) as Promise<Record<string, unknown>>

describe("declared shape inputs", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  const advertised = src.slice(src.indexOf("  shapes: ["), src.indexOf("executor: new ActivityExecutor"))

  for (const [shape, raw] of Object.entries(SHAPE_INPUTS)) {
    const schema = raw as unknown as Schema
    it(`${shape}: advertised, served, described, and its required fields are declared properties`, () => {
      expect(advertised).toContain(`"${shape}"`)
      expect(resolvers.has(shape)).toBe(true)
      expect(SHAPE_DESCRIPTIONS[shape]?.length ?? 0).toBeGreaterThan(0)
      for (const f of schema.required) expect(Object.keys(schema.properties)).toContain(f)
    })
    it(`${shape}: its handler, given exactly the required fields, does not ask for more, and answers with its declared shape`, async () => {
      const pointer = Object.fromEntries(schema.required.map((f) => [f, sample(f)]))
      // A handler may refuse the request for another reason (a directory this host lacks is answered 422): only a demand
      // for a field the schema does not declare fails this.
      const out = await call(shape, pointer).catch((e: Error) => ({ error: e.message }))
      expect(String(out?.error ?? "")).not.toMatch(/required/i)
      // An answer that names its shape names the one declared for it (shape_answers), so what discovery says a call
      // makes is what it makes.
      const answered = (out as Record<string, unknown> | undefined)?.shape
      if (typeof answered === "string") expect(answered).toBe(SHAPE_ANSWERS[shape])
    }, 60_000)
  }

  it("[MUST-FAIL] no declared field reaches a command line unchecked (agf_m40aao3ttwpx)", () => {
    const typecheck = SHAPE_INPUTS.code_verify_typecheck as unknown as Schema
    expect(Object.keys(typecheck.properties)).not.toContain("script")
    expect(Object.keys(typecheck.properties)).not.toContain("bun_cmd")
  })

  it("the clone-removing handler called here can reach only a temporary clones directory and no records (a guard)", () => {
    expect(String(process.env.WALK_TREES_DIR).startsWith(dir)).toBe(true)
    expect(process.env.DISCOVERY_ENDPOINT).toBe("http://127.0.0.1:9")
  })

  it("[MUST-FAIL] fs_edit's contract says old_string is copied from an fs_read of the file, never words about the change", () => {
    const edit = SHAPE_INPUTS.fs_edit as unknown as { properties: Record<string, { description?: string }> }
    expect(SHAPE_DESCRIPTIONS.fs_edit).toContain("fs_read")
    expect(SHAPE_DESCRIPTIONS.fs_edit).toContain("read the file first")
    expect(String(edit.properties.old_string.description)).toContain("character for character")
    expect(String(edit.properties.old_string.description)).toContain("never words about the change")
  })

  it("[MUST-FAIL] each declared answer is for a declared shape, and the diff a landing is judged on comes from git_diff", () => {
    for (const shape of Object.keys(SHAPE_ANSWERS)) expect(Object.keys(SHAPE_INPUTS)).toContain(shape)
    expect(SHAPE_ANSWERS.git_diff).toBe("gitDiff")
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
    expect(src).toContain("shapeAnswers: SHAPE_ANSWERS")
  })

  // Read from the source, not from a call: a call answers only where the handler can run (bounded_shell's default
  // directory is absent outside a node), and a refusal names no shape, so a check on what a call answered passed
  // wherever the handler was refused. Each declared answer is every shape the tool's handler returns, or any function it
  // hands the call to (in its own module or one it imports) returns.
  it("[MUST-FAIL] each declared answer is the shape its handler answers with (bounded_shell answers boundedShellResult)", () => {
    const read = (m: string) => readFileSync(join(import.meta.dir, `${m}.ts`), "utf8")
    const importsOf = (text: string) => {
      const out = new Map<string, string>()
      for (const m of text.matchAll(/^import \{([^}]*)\} from "\.\/([\w-]+)(?:\.js)?"/gm))
        for (const name of m[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!).filter(Boolean)) out.set(name, m[2])
      return out
    }
    // A top-level definition's text, from its name to the next top-level definition.
    const definition = (text: string, name: string): string => {
      const start = text.search(new RegExp(`^(?:export )?(?:const ${name}\\b|(?:async )?function ${name}\\b)`, "m"))
      if (start === -1) return ""
      const end = text.slice(start + 1).search(/\n(?:export |const |let |function |async function |class )/)
      return text.slice(start, end === -1 ? undefined : start + 1 + end)
    }
    const answers = (module: string, name: string, seen: Set<string>): string[] => {
      if (seen.has(`${module}:${name}`)) return []
      seen.add(`${module}:${name}`)
      const text = read(module)
      const body = definition(text, name)
      const imports = importsOf(text)
      const called = [...new Set([...body.matchAll(/\b(\w+)\(/g)].map((m) => m[1]))].filter((f) => f !== name)
      return [
        ...[...body.matchAll(/(?:return|=>)\s*\(?\{\s*shape: "(\w+)"/g)].map((m) => m[1]),
        ...called.flatMap((f) => imports.has(f) ? answers(imports.get(f)!, f, seen) : definition(text, f) ? answers(module, f, seen) : []),
      ]
    }
    const index = read("index")
    for (const [tool, declared] of Object.entries(SHAPE_ANSWERS)) {
      const handler = index.match(new RegExp(`\\["${tool}", (\\w+)\\]`))?.[1] ?? ""
      const found = answers("index", handler, new Set())
      expect({ tool, answers: found.length > 0 }).toEqual({ tool, answers: true })
      for (const shape of found) expect({ tool, shape }).toEqual({ tool, shape: declared })
    }
  })

  it("every described shape is declared, and the other way round", () => {
    expect(Object.keys(SHAPE_DESCRIPTIONS).sort()).toEqual(Object.keys(SHAPE_INPUTS).sort())
  })
})
