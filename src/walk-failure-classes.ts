// SPDX-License-Identifier: MIT
// Walk failure classes: which of the walk's failures are the same failure, from the rows' own fields, never a pattern
// over their words. A class is the tool (the started hop's pointer_type), the failure's kind, refused, blames and
// waits_for, its status band, and its body with every value the call or its rows put there replaced by that value's
// name: the call's own argument values (args[k] → <k>) and the failure row's own ids (its call_id, selection_ref and
// input_refs). What is left is what the tool said, the same for every call that failed the same way.
export type Row = { id: string; seq: number; shape: string; role?: string; [k: string]: unknown }
export type ClassKey = string
export type Klass = { key: ClassKey; tool: string; kind?: string; refused?: string; blames?: string; waits_for?: string;
  status_band: string; signature: string; example: string; failures: string[]; roots: string[]; first_seq: number; last_seq: number; infra: boolean }

// Whom a failure blames, as records reads it (fold.ts blamed): its stamp, else, for a row written before the stamp, a
// 4xx other than 401/403/408/429 with no kind blames the request and anything else the callee.
const NOT_THE_REQUEST = new Set([401, 403, 408, 429])
const blamedCallee = (f: Row): boolean => typeof f.blames === "string" ? f.blames === "callee"
  : !(f.kind === undefined && typeof f.status === "number" && f.status !== 200 && f.status >= 400 && f.status < 500 && !NOT_THE_REQUEST.has(f.status))
// Whether the callee answered at all: a forward that failed (discovery and the transport set error "forward_failed"),
// a stop (status 0) or no status is no answer: infra. A callee that answered, even with its own 5xx (a crash in its own
// code), answered: its failure is work, not infra. Read from the body's own JSON field, never its words.
const unanswered = (f: Row): boolean => {
  if (typeof f.status !== "number" || f.status === 0) return true
  const parsed = ((): unknown => { try { return typeof f.body === "string" ? JSON.parse(f.body) : f.body } catch { return undefined } })()
  const inner = (x: unknown): unknown => typeof x === "object" && x !== null ? (x as Record<string, unknown>) : undefined
  const o = inner(parsed) as Record<string, unknown> | undefined
  const nested = o && typeof o.failure === "object" && o.failure !== null ? (o.failure as Record<string, unknown>).body : undefined
  const n = ((): Record<string, unknown> | undefined => { try { return typeof nested === "string" ? JSON.parse(nested) : (nested as Record<string, unknown> | undefined) } catch { return undefined } })()
  return o?.error === "forward_failed" || n?.error === "forward_failed"
}
const band = (s: unknown): string => typeof s === "number" ? (s >= 500 ? "5xx" : s >= 400 ? "4xx" : s === 200 ? "200" : String(s)) : "none"

// Every occurrence of a known value replaced by its name, longest values first (a path before its own prefix), by plain
// string replacement: no pattern.
export const signatureOf = (body: string, known: Array<[string, string]>): string => {
  let out = body
  for (const [name, value] of [...known].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length)) {
    out = out.split(value).join(`<${name}>`)
  }
  return out
}

const flatArgs = (args: unknown, prefix = ""): Array<[string, string]> => {
  if (typeof args !== "object" || args === null) return []
  return Object.entries(args as Record<string, unknown>).flatMap(([k, v]) => typeof v === "string" ? [[prefix + k, v] as [string, string]]
    : typeof v === "number" ? [[prefix + k, String(v)] as [string, string]] : flatArgs(v, `${prefix}${k}.`))
}

/** The walk's failures grouped into classes. `ownRoots` maps a class to the roots its own gap's repair works on (every
 *  row of that gap is a root in turn): failures on them are not counted toward that class, so a repair's own failures
 *  never raise or reopen its own gap. */
export const classesOf = (pool: Row[], ownRoots: Map<ClassKey, ReadonlySet<string>> = new Map()): Klass[] => {
  const started = new Map(pool.filter((r) => r.shape === "hop" && r.role === "walk" && r.phase === "started").map((h) => [String(h.call_id), h]))
  const sels = new Map(pool.filter((r) => r.shape === "selection").map((s) => [s.id, s]))
  const byId = new Map(pool.map((r) => [r.id, r]))
  const out = new Map<ClassKey, Klass>()
  for (const f of pool.filter((r) => r.shape === "failure" && r.role === "walk" && typeof r.call_id === "string").sort((a, b) => a.seq - b.seq)) {
    if (f.status === 0) continue // a call cut by a stop says nothing about the call
    const h = started.get(String(f.call_id))
    const sel = sels.get(String(f.selection_ref))
    const tool = h !== undefined ? String(h.pointer_type) : String(sel?.a ?? "unknown")
    // The call's own values: a template call's args on its started hop, else (a direct call) the pointer of the request
    // row its selection was made from, which is what the call was sent.
    const sent = h?.args !== undefined ? h.args : byId.get(String(sel?.from ?? ""))?.pointer
    const known: Array<[string, string]> = [
      ...flatArgs(sent),
      ["call_id", String(f.call_id)], ["selection_ref", String(f.selection_ref)],
      ...[f.input_refs].flat().filter((x) => typeof x === "string").map((x, i) => [`input_ref.${i}`, String(x)] as [string, string]),
    ]
    const body = typeof f.body === "string" ? f.body : JSON.stringify(f.body ?? "")
    // A produce's failure quotes the model's own output (an id it cited, a text it wrote), which differs on every call:
    // it is classed by its fields alone (the step's kind of failure: refused, blames, status), never by its body. A tool's
    // failure is what the tool said, classed by its body with the call's own values named.
    const produce = String(sel?.a ?? "").startsWith("produce/") || h?.kind === "produce"
    const signature = produce ? "" : signatureOf(body, known)
    const fields = { kind: f.kind, refused: f.refused, blames: f.blames ?? (blamedCallee(f) ? "callee" : "request"), waits_for: f.waits_for } as Record<string, unknown>
    const s = (k: string) => typeof fields[k] === "string" ? String(fields[k]) : undefined
    const key = new Bun.CryptoHasher("sha256").update(JSON.stringify([tool, s("kind"), s("refused"), s("blames"), s("waits_for"), band(f.status), unanswered(f), signature])).digest("hex").slice(0, 24)
    // A failure whose selection names no root is counted under its move (the template or call it ran), never dropped.
    const root = typeof sel?.root === "string" && sel.root !== "" ? sel.root : `move:${String(sel?.a ?? tool)}`
    if (ownRoots.get(key)?.has(root) === true) continue
    const k = out.get(key) ?? { key, tool, kind: s("kind"), refused: s("refused"), blames: s("blames"), waits_for: s("waits_for"), status_band: band(f.status),
      signature, example: body.slice(0, 500), failures: [], roots: [], first_seq: f.seq, last_seq: f.seq, infra: blamedCallee(f) && unanswered(f) }
    k.failures.push(f.id)
    if (root !== "" && !k.roots.includes(root)) k.roots.push(root)
    k.last_seq = f.seq
    k.example = body.slice(0, 500)
    out.set(key, k)
  }
  return [...out.values()].sort((a, b) => b.failures.length - a.failures.length)
}
