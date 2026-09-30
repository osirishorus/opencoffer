import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The Amount component splits Intl parts into a "head" (symbol + integer) and a
 * "tail" (decimal separator + cents). These tests pin the splitting rules
 * against real currency shapes without needing to render React.
 */
function split(value: number, currency: string, locale = "en-US") {
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).formatToParts(Math.abs(value));

  const head: string[] = [];
  const cents: string[] = [];
  const suffix: string[] = [];
  let phase: "head" | "cents" | "suffix" = "head";
  for (const part of parts) {
    if (part.type === "decimal") {
      phase = "cents";
      cents.push(part.value);
      continue;
    }
    if (phase === "cents" && part.type !== "fraction") phase = "suffix";
    (phase === "head" ? head : phase === "cents" ? cents : suffix).push(part.value);
  }
  return { head: head.join(""), tail: cents.join(""), suffix: suffix.join("") };
}

test("USD splits cents into the demoted tail", () => {
  assert.deepEqual(split(1234.56, "USD"), { head: "$1,234", tail: ".56", suffix: "" });
});

test("whole amounts still carry a .00 tail so columns align", () => {
  assert.deepEqual(split(1000, "USD"), { head: "$1,000", tail: ".00", suffix: "" });
});

test("currencies with no minor unit produce no tail", () => {
  // Yen has zero decimal digits — there is nothing to demote.
  assert.deepEqual(split(1000, "JPY"), { head: "¥1,000", tail: "", suffix: "" });
});

test("trailing-symbol currencies keep the symbol out of the tail", () => {
  // de-DE renders "1.234,56 €" — the space and € must not be demoted with the cents.
  const { head, tail, suffix } = split(1234.56, "EUR", "de-DE");
  assert.equal(tail, ",56");
  assert.ok(head.includes("1.234"));
  assert.ok(!tail.includes("€"), "currency symbol must stay at full size");
  assert.ok(suffix.includes("€"), "symbol trails the cents, keeping its position");
});

test("head and tail always recombine to the original formatting", () => {
  for (const [value, currency, locale] of [
    [0, "USD", "en-US"],
    [0.07, "USD", "en-US"],
    [999999.99, "USD", "en-US"],
    [42, "GBP", "en-US"],
    [1234.56, "EUR", "de-DE"],
    [1000, "JPY", "en-US"],
  ] as const) {
    const { head, tail, suffix } = split(value, currency, locale);
    const expected = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).format(Math.abs(value));
    assert.equal(head + tail + suffix, expected, `${value} ${currency} @ ${locale}`);
  }
});
