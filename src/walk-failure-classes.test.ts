// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { classesOf, signatureOf, type Row } from "./walk-failure-classes"

let n = 0
const call = (root: string, tool: string, args: Record<string, unknown>, fail: Record<string, unknown>): Row[] => {
  const s = { id: `s${++n}`, seq: n, shape: "selection", role: "walk", root, a: `call/${tool}` }
  const h = { id: `h${++n}`, seq: n, shape: "hop", role: "walk", phase: "started", selection_ref: s.id, call_id: `c${n}`, pointer_type: tool, args }
  const f = { id: `f${++n}`, seq: n, shape: "failure", role: "walk", selection_ref: s.id, call_id: h.call_id, input_refs: [root], ...fail }
  return [s, h, f]
}

describe("walk failure classes", () => {
  test("[MUST-FAIL] the same failure across clones (paths are the call's own args) is one class", () => {
    const rows = [...call("w1", "git_diff", { cwd: "/trees/super-a" }, { status: 422, body: "no such directory: /trees/super-a" }),
      ...call("w2", "git_diff", { cwd: "/trees/super-b" }, { status: 422, body: "no such directory: /trees/super-b" })]
    const k = classesOf(rows)
    expect(k).toHaveLength(1)
    expect(k[0]).toMatchObject({ tool: "git_diff", roots: ["w1", "w2"], signature: "no such directory: <cwd>" })
  })

  test("[MUST-FAIL] the literal unbound placeholder is one class across roots (157 on node1)", () => {
    const body = "no such directory: {{ sig.in[0].cwd }}"
    const rows = Array.from({ length: 5 }, (_, i) => call(`w${i}`, "git_diff", { cwd: "{{ sig.in[0].cwd }}" }, { status: 422, body })).flat()
    const k = classesOf(rows)
    expect(k).toHaveLength(1)
    expect(k[0].failures).toHaveLength(5)
  })

  test("[MUST-FAIL] the failure row's own ids do not split a class", () => {
    const rows = [...call("w1", "git_land", {}, { status: 422, body: "" }), ...call("w2", "git_land", {}, { status: 422, body: "" })]
    rows[2].body = `refused for call ${rows[2].call_id}`; rows[5].body = `refused for call ${rows[5].call_id}`
    expect(classesOf(rows)).toHaveLength(1)
  })

  test("different tools, kinds or status bands are different classes; a cut call is no class", () => {
    const rows = [...call("w1", "git_diff", {}, { status: 422, body: "x" }), ...call("w1", "git_commit", {}, { status: 422, body: "x" }),
      ...call("w1", "git_diff", {}, { status: 502, body: "x" }), ...call("w1", "git_diff", {}, { status: 0, body: "stopped" })]
    expect(classesOf(rows)).toHaveLength(3)
  })

  test("[MUST-FAIL] infra is the blames field (callee), never the status alone", () => {
    const rows = [...call("w1", "answer", {}, { status: 502, body: JSON.stringify({ error: "forward_failed" }), blames: "callee" }), ...call("w1", "git_diff", {}, { status: 500, body: "own bug", blames: "request" })]
    const k = classesOf(rows)
    expect(k.find((x) => x.tool === "answer")?.infra).toBe(true)
    expect(k.find((x) => x.tool === "git_diff")?.infra).toBe(false)
  })

  test("[MUST-FAIL] a gap's own repair root never counts toward its own class", () => {
    const rows = [...call("w1", "git_diff", { cwd: "/t/a" }, { status: 422, body: "boom /t/a" }), ...call("gap-root", "git_diff", { cwd: "/t/b" }, { status: 422, body: "boom /t/b" })]
    const key = classesOf(rows)[0].key
    const k = classesOf(rows, new Map([[key, new Set(["gap-root"])]]))
    expect(k[0].roots).toEqual(["w1"])
  })

  test("[MUST-FAIL] a direct call's values come from the request row it was made from (its hop has no args)", () => {
    const direct = (root: string, cwd: string): Row[] => {
      const req = { id: `rq${++n}`, seq: n, shape: "request", role: "described", pointer: { type: "git_diff", cwd } }
      const s = { id: `s${++n}`, seq: n, shape: "selection", role: "walk", root, a: "call/git_diff", from: req.id }
      const h = { id: `h${++n}`, seq: n, shape: "hop", role: "walk", phase: "started", selection_ref: s.id, call_id: `c${n}`, pointer_type: "git_diff" }
      const f = { id: `f${++n}`, seq: n, shape: "failure", role: "walk", selection_ref: s.id, call_id: h.call_id, status: 422, body: `no such directory: ${cwd}` }
      return [req, s, h, f]
    }
    expect(classesOf([...direct("w1", "/trees/a"), ...direct("w2", "/trees/b")])).toHaveLength(1)
  })

  test("[MUST-FAIL] an unstamped forward timeout (no status) is infra, as records blames it; a root-less failure counts under its move", () => {
    const rows = call("", "record_wait", {}, { body: "forward_failed timed out" })
    rows[0].root = undefined as unknown as string
    const k = classesOf(rows)
    expect(k[0].infra).toBe(true)
    expect(k[0].roots).toEqual(["move:call/record_wait"])
  })

  test("[MUST-FAIL] a produce's failure is classed by its fields, not the model's words it quotes", () => {
    const prod = (root: string, body: string): Row[] => {
      const s = { id: `s${++n}`, seq: n, shape: "selection", role: "walk", root, a: "produce/answer/ch1" }
      const h = { id: `h${++n}`, seq: n, shape: "hop", role: "walk", phase: "started", kind: "produce", selection_ref: s.id, call_id: `c${n}`, pointer_type: "answer" }
      return [s, h, { id: `f${++n}`, seq: n, shape: "failure", role: "walk", selection_ref: s.id, call_id: h.call_id, status: 422, refused: "schema", body }]
    }
    const k = classesOf([...prod("w1", "/uses/1 \"aaa\" is not a row it was shown"), ...prod("w2", "/uses/0 \"bbb\" is not a row it was shown")])
    expect(k).toHaveLength(1)
    expect(k[0]).toMatchObject({ tool: "answer", refused: "schema", roots: ["w1", "w2"] })
  })

  test("[MUST-FAIL] C1: a callee that answered with its own 5xx is work; one never reached is infra (two classes)", () => {
    const rows = [...call("w1", "answer", {}, { status: 500, blames: "callee", body: JSON.stringify({ failure: { status: 500, body: "TypeError: x" } }) }),
      ...call("w2", "answer", {}, { status: 502, blames: "callee", body: JSON.stringify({ error: "forward_failed", detail: "timed out" }) })]
    const k = classesOf(rows)
    expect(k).toHaveLength(2)
    expect(k.map((c) => c.infra).sort()).toEqual([false, true])
  })

  test("[MUST-FAIL] C2: produce classes keep their target: the same fields on answer and on request are two classes", () => {
    const prod = (target: string, body: string): Row[] => {
      const s = { id: `s${++n}`, seq: n, shape: "selection", role: "walk", root: "w1", a: `produce/${target}/ch1` }
      const h = { id: `h${++n}`, seq: n, shape: "hop", role: "walk", phase: "started", kind: "produce", selection_ref: s.id, call_id: `c${n}`, pointer_type: target }
      return [s, h, { id: `f${++n}`, seq: n, shape: "failure", role: "walk", selection_ref: s.id, call_id: h.call_id, status: 422, refused: "schema", body }]
    }
    expect(classesOf([...prod("answer", "a"), ...prod("answer", "b")])).toHaveLength(1)
    expect(classesOf([...prod("answer", "a"), ...prod("request", "a")])).toHaveLength(2)
  })

  test("signatureOf replaces longest known values first, by plain string replacement", () => {
    expect(signatureOf("/t/a/b and /t/a", [["root", "/t/a"], ["file", "/t/a/b"]])).toBe("<file> and <root>")
  })

  test("[MUST-FAIL] no RegExp is used on bodies (the class is from fields and known values)", () => {
    const src = readFileSync(new URL("./walk-failure-classes.ts", import.meta.url), "utf8")
    expect(/new RegExp|\.match\(|\.replace\(\/|\.test\(/.test(src)).toBe(false)
  })
})
