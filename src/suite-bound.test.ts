// How long the whole suite's runs may take is the owner's to say (suite_bound rows), read at use, newest first whatever
// its scope, for this repository or for none, and clamped to a timer's largest delay; with no usable row, git_diff's step
// bound holds. Only the owner's rows are read.
import { describe, expect, test } from "bun:test";
import { SUITE_MS_MAX, suiteBoundOf } from "./suite-bound.js";
import type { Query, Row } from "./walk-rows.js";

const rowsOf = (found: Row[] | { error: string }) => async (q: Query) => Array.isArray(found) ? found.filter((r) => r.shape === q.shape) : found;
const bound = (id: string, seq: number, more: Record<string, unknown>): Row => ({ id, seq, shape: "suite_bound", role: "owner", ...more });

describe("the whole suite's bound, as the owner sets it", () => {
  test("[MUST-FAIL] the newest suite_bound row for this repository, or for none, is read; another repository's is not", async () => {
    expect(await suiteBoundOf(rowsOf([bound("b1", 1, { suite_step_ms: 330_000 })]), "demo")).toBe(330_000);
    expect(await suiteBoundOf(rowsOf([bound("b1", 1, { repo: "demo", suite_step_ms: 330_000 })]), "demo")).toBe(330_000);
    expect(await suiteBoundOf(rowsOf([bound("b1", 1, { repo: "other", suite_step_ms: 330_000 })]), "demo")).toBeUndefined();
    // newest by seq, whatever order the rows come in, and whatever its scope: a newer row naming no repo replaces an older
    // one naming this repo
    const two = [bound("b2", 2, { suite_step_ms: 400_000 }), bound("b1", 1, { repo: "demo", suite_step_ms: 330_000 })];
    expect(await suiteBoundOf(rowsOf(two), "demo")).toBe(400_000);
    expect(await suiteBoundOf(rowsOf([...two].reverse()), "demo")).toBe(400_000);
    expect(await suiteBoundOf(rowsOf([...two, bound("b3", 3, { repo: "other", suite_step_ms: 1 })]), "demo")).toBe(400_000);
  });

  test("[MUST-FAIL] only the owner's rows are read: a newer row of any other writer changes nothing", async () => {
    const own = bound("b1", 1, { suite_step_ms: 330_000 })
    for (const role of ["walk", "described", "detector", undefined]) {
      const other = { ...bound("x2", 2, { suite_step_ms: 1 }), role }
      expect(await suiteBoundOf(rowsOf([own, other]), "demo")).toBe(330_000)
      expect(await suiteBoundOf(rowsOf([own, { ...other, suite_step_ms: "x" }]), "demo")).toBe(330_000)
      expect(await suiteBoundOf(rowsOf([{ ...other, repo: "demo" }]), "demo")).toBeUndefined()
    }
  });

  test("[MUST-FAIL] no row, rows that cannot be read, or a newest row naming no positive number: no owner bound", async () => {
    expect(await suiteBoundOf(rowsOf([]), "demo")).toBeUndefined();
    expect(await suiteBoundOf(rowsOf({ error: "records is down" }), "demo")).toBeUndefined();
    for (const v of ["330000", 0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(await suiteBoundOf(rowsOf([bound("b1", 1, { suite_step_ms: 330_000 }), bound("b2", 2, { suite_step_ms: v })]), "demo")).toBeUndefined();
    }
  });

  test("[MUST-FAIL] a bound past a timer's largest delay is clamped to it", async () => {
    expect(SUITE_MS_MAX).toBe(2 ** 31 - 1);
    expect(await suiteBoundOf(rowsOf([bound("b1", 1, { suite_step_ms: 3e9 })]), "demo")).toBe(SUITE_MS_MAX);
    expect(await suiteBoundOf(rowsOf([bound("b1", 1, { suite_step_ms: SUITE_MS_MAX })]), "demo")).toBe(SUITE_MS_MAX);
  });
});
