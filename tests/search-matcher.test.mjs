import assert from "node:assert/strict";
import { test } from "node:test";
import { rank, score, termsOf } from "../src/features/search/matcher.ts";

test("search terms ignore whitespace and case", () => {
  assert.deepEqual(termsOf("  SSH  Git\tSync  "), ["ssh", "git", "sync"]);
  assert.deepEqual(termsOf("   "), []);
});

test("substring scoring favors prefixes and word boundaries", () => {
  assert.equal(score("terminal", "term"), 100);
  assert.equal(score("my-terminal", "term"), 60);
  assert.equal(score("myterminal", "term"), 30);
  assert.equal(score("terminal", "missing"), -1);
});

test("ranking requires every term and favors title matches", () => {
  const item = { title: "Git sync", hay: "git sync remote" };
  assert.equal(rank(item, ["git", "sync"]), 200);
  assert.equal(rank(item, ["git", "missing"]), -1);
  assert.equal(rank({ title: "Other", hay: "git sync remote" }, ["git"]), 100);
});
