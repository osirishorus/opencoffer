import assert from "node:assert/strict";
import { test } from "node:test";
import { financeTools } from "@/lib/finance/tools";
import { tokenCanWrite } from "./server";

test("legacy 'all' tokens are read-only", () => {
  assert.equal(tokenCanWrite(["all"]), false);
  assert.equal(tokenCanWrite([]), false);
  assert.equal(tokenCanWrite(["all", "write"]), true);
  assert.equal(tokenCanWrite(["write"]), true);
});

test("every tool that changes stored data is flagged as mutating", () => {
  const expected = [
    "set_transaction_category",
    "bulk_set_category_by_merchant",
    "run_categorization",
    "set_account_group",
    "remember",
    "forget",
  ].sort();
  const actual = financeTools
    .filter((t) => t.mutates)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(actual, expected);
});
