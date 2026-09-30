import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRecurring, classifyCadence, median } from "./recurring";

const d = (s: string) => new Date(`${s}T12:00:00Z`);

test("median handles odd and even lengths", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test("classifyCadence buckets common billing intervals", () => {
  assert.equal(classifyCadence(7), "weekly");
  assert.equal(classifyCadence(14), "biweekly");
  assert.equal(classifyCadence(31), "monthly");
  assert.equal(classifyCadence(28), "monthly");
  assert.equal(classifyCadence(92), "quarterly");
  assert.equal(classifyCadence(365), "annual");
  assert.equal(classifyCadence(50), "irregular");
  assert.equal(classifyCadence(null), "irregular");
});

test("monthly subscription: next charge and active status", () => {
  const r = analyzeRecurring(
    [
      { date: d("2026-06-05"), amount: -15.49 },
      { date: d("2026-07-05"), amount: -15.49 },
      { date: d("2026-08-05"), amount: -15.49 },
      { date: d("2026-09-05"), amount: -15.49 },
    ],
    d("2026-09-20"),
  )!;
  assert.equal(r.cadence, "monthly");
  assert.equal(r.monthlyEquivalent, 15.49);
  assert.equal(r.nextExpected?.toISOString().slice(0, 10), "2026-10-05");
  assert.equal(r.active, true);
  assert.equal(r.priceChange, null);
});

test("lapsed subscription is inactive", () => {
  const r = analyzeRecurring(
    [
      { date: d("2026-01-05"), amount: -9.99 },
      { date: d("2026-02-05"), amount: -9.99 },
      { date: d("2026-03-05"), amount: -9.99 },
    ],
    d("2026-09-20"),
  )!;
  assert.equal(r.active, false);
});

test("annual charge normalises to a monthly equivalent", () => {
  const r = analyzeRecurring(
    [
      { date: d("2024-03-01"), amount: -120 },
      { date: d("2025-03-01"), amount: -120 },
    ],
    d("2025-06-01"),
  )!;
  assert.equal(r.cadence, "annual");
  assert.equal(r.monthlyEquivalent, 10);
  assert.equal(r.active, true);
});

test("weekly charges scale up to a monthly equivalent", () => {
  const r = analyzeRecurring(
    [
      { date: d("2026-09-01"), amount: -10 },
      { date: d("2026-09-08"), amount: -10 },
      { date: d("2026-09-15"), amount: -10 },
    ],
    d("2026-09-16"),
  )!;
  assert.equal(r.cadence, "weekly");
  assert.equal(r.monthlyEquivalent, 43.33);
});

test("detects a price increase on the latest charge", () => {
  const r = analyzeRecurring(
    [
      { date: d("2026-06-05"), amount: -15.49 },
      { date: d("2026-07-05"), amount: -15.49 },
      { date: d("2026-08-05"), amount: -15.49 },
      { date: d("2026-09-05"), amount: -17.99 },
    ],
    d("2026-09-10"),
  )!;
  assert.deepEqual(r.priceChange, { from: 15.49, to: 17.99, pct: 16.14 });
});

test("ignores small price noise", () => {
  const r = analyzeRecurring(
    [
      { date: d("2026-06-05"), amount: -52.1 },
      { date: d("2026-07-05"), amount: -51.8 },
      { date: d("2026-08-05"), amount: -52.4 },
    ],
    d("2026-08-10"),
  )!;
  assert.equal(r.priceChange, null);
});
