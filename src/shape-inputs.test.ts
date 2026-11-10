// Pins each declared input schema (shape-inputs.ts) to its handler: every handler, called with exactly the required
// fields its schema declares, gets past its own "is required" check. A handler edited to need another field without
// its schema following turns this red, so what discovery tells the walk to send stays what the handler reads.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolvers } from "./index"
import { SHAPE_DESCRIPTIONS, SHAPE_INPUTS } from "./shape-inputs"

type Schema = { required: string[]; properties: Record<string, { type?: string }> }

// A file under tmp (a tool root) with three lines, and a value for every field a schema can require.
const dir = mkdtempSync(join(tmpdir(), "shape-inputs-"))
const sample = (field: string): unknown => {
  const file = join(dir, `f-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(file, "line1\nline2\nline3\n")
  const values: Record<string, unknown> = {
    path: file, content: "x", old_string: "line1", new_string: "LINE1", start_line: 1, end_line: 2, text: "t",
    after_line: 0, pattern: "line", cwd: dir, command: "true", script: "typecheck",
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
    it(`${shape}: its handler, given exactly the required fields, does not ask for more`, async () => {
      const pointer = Object.fromEntries(schema.required.map((f) => [f, sample(f)]))
      const out = await call(shape, pointer)
      expect(String(out?.error ?? "")).not.toMatch(/required/i)
    }, 60_000)
  }

  it("every described shape is declared, and the other way round", () => {
    expect(Object.keys(SHAPE_DESCRIPTIONS).sort()).toEqual(Object.keys(SHAPE_INPUTS).sort())
  })
})
