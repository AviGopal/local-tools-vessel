// SPDX-License-Identifier: MIT
// Walk failure classes: which of the walk's failures are the same failure, from the rows' own fields, never a pattern
// over their words. A class is the tool (the started hop's pointer_type), the failure's kind, refused, blames and
// waits_for, its status band, and its body with every value the call or its rows put there replaced by that value's
// name: the call's own argument values (args[k] → <k>) and the failure row's own ids (its call_id, selection_ref and
// input_refs). What is left is what the tool said, the same for every call that failed the same way.
export type Row = { id: string; seq: number; shape: string; role?: string; [k: string]: unknown }
/** The walk's word that a root offered no move for its owner's stall_rule selections (walk loop.ts stalls). */
export const STALL = "stall"
/** The kind of a selection records said made what nobody took: it stamps use {r, key} on a selection it reads when its
 *  fold judged that selection by its use (fold.ts useGrades), r 0 when no other move took its output within the owner's
 *  promise_window, r 1 when one did. This reads that stamp only, never a copy of records' rule. */
export const UNUSED = "unused"
export const useOf = (s: Row): unknown => (s.use as { r?: unknown } | undefined)?.r
export type ClassKey = string
export type Klass = { key: ClassKey; tool: string; kind?: string; refused?: string; blames?: string; waits_for?: string;
  status_band: string; signature: string; example: string; failures: string[]; roots: string[]; first_seq: number; last_seq: number; infra: boolean }

// Whom a failure blames is records' to say: it stamps blames on every walk failure row it stores (fold.ts blames), and
// this reads that stamp only, never a copy of records' rule. A row written before the stamp is its own class, blames
// "unstamped" (named debt: it leaves when no unstamped failure is left in a detector's window). A failure that blames
// the callee (an outage, a timeout, a crash in what was called) is infra, the USER's
// ruling: filed, not offered to the walk.
const blamesOf = (f: Row): string => typeof f.blames === "string" ? f.blames : "unstamped"
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
 *  never raise or reopen its own gap. A selection stamped unused counts only after `unusedAfter`, the window its
 *  failures are read in. */
export const classesOf = (pool: Row[], ownRoots: Map<ClassKey, ReadonlySet<string>> = new Map(), unusedAfter = -1): Klass[] => {
  const started = new Map(pool.filter((r) => r.shape === "hop" && r.role === "walk" && r.phase === "started").map((h) => [String(h.call_id), h]))
  const sels = new Map(pool.filter((r) => r.shape === "selection").map((s) => [s.id, s]))
  const byId = new Map(pool.map((r) => [r.id, r]))
  const out = new Map<ClassKey, Klass>()
  for (const f of pool.filter((r) => r.shape === "failure" && r.role === "walk" && (typeof r.call_id === "string" || r.kind === STALL)).sort((a, b) => a.seq - b.seq)) {
    // A root the walk said has no move (kind stall: no call, no selection of its own) is a class of its own: tool stall,
    // its root the row's, keyed by its fields alone. Never work for the walk (a walk cannot repair its own stall): the
    // gap is the fact that the root sat with no move, for whoever reads gaps.
    if (f.kind === STALL) {
      const key = new Bun.CryptoHasher("sha256").update(JSON.stringify([STALL, STALL])).digest("hex").slice(0, 24)
      const root = typeof f.root === "string" && f.root !== "" ? f.root : "move:stall"
      if (ownRoots.get(key)?.has(root) === true) continue
      const k = out.get(key) ?? { key, tool: STALL, kind: STALL, status_band: band(f.status), signature: "", example: "",
        failures: [], roots: [], first_seq: f.seq, last_seq: f.seq, infra: true }
      k.failures.push(f.id)
      if (!k.roots.includes(root)) k.roots.push(root)
      k.last_seq = f.seq
      out.set(key, k)
      continue
    }
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
    // Nor does its example carry those words: a gap row is a root producers read, and a model's quoted text there would
    // be handed on as if it were the failure. A tool's body is the tool's own words.
    const example = produce ? "" : body.slice(0, 500)
    const fields = { kind: f.kind, refused: f.refused, blames: blamesOf(f), waits_for: f.waits_for } as Record<string, unknown>
    const s = (k: string) => typeof fields[k] === "string" ? String(fields[k]) : undefined
    const key = new Bun.CryptoHasher("sha256").update(JSON.stringify([tool, s("kind"), s("refused"), s("blames"), s("waits_for"), band(f.status), signature])).digest("hex").slice(0, 24)
    // A failure whose selection names no root is counted under its move (the template or call it ran), never dropped.
    const root = typeof sel?.root === "string" && sel.root !== "" ? sel.root : `move:${String(sel?.a ?? tool)}`
    if (ownRoots.get(key)?.has(root) === true) continue
    const k = out.get(key) ?? { key, tool, kind: s("kind"), refused: s("refused"), blames: s("blames"), waits_for: s("waits_for"), status_band: band(f.status),
      signature, example, failures: [], roots: [], first_seq: f.seq, last_seq: f.seq, infra: blamesOf(f) === "callee" }
    k.failures.push(f.id)
    if (root !== "" && !k.roots.includes(root)) k.roots.push(root)
    k.last_seq = f.seq
    k.example = example
    out.set(key, k)
  }
  // A selection whose output nobody took (records' stamp, use r 0) is a class of its own: tool its move, kind unused,
  // keyed by the move alone, its root the selection's. Never work for the walk: the walk is what offered nothing to take
  // it, so the gap is the fact, for whoever reads gaps.
  for (const s of pool.filter((r) => r.shape === "selection" && r.seq > unusedAfter && useOf(r) === 0).sort((a, b) => a.seq - b.seq)) {
    const tool = String(s.a ?? "unknown")
    const key = new Bun.CryptoHasher("sha256").update(JSON.stringify([UNUSED, tool])).digest("hex").slice(0, 24)
    const root = typeof s.root === "string" && s.root !== "" ? s.root : `move:${tool}`
    if (ownRoots.get(key)?.has(root) === true) continue
    const k = out.get(key) ?? { key, tool, kind: UNUSED, status_band: "none", signature: "", example: "",
      failures: [], roots: [], first_seq: s.seq, last_seq: s.seq, infra: true }
    k.failures.push(s.id)
    if (!k.roots.includes(root)) k.roots.push(root)
    k.last_seq = s.seq
    out.set(key, k)
  }
  return [...out.values()].sort((a, b) => b.failures.length - a.failures.length)
}
