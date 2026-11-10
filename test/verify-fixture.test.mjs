/**
 * Fixture for scripts/verify-test.mjs: tiny tests with the shapes the prover must tell apart.
 * It is deliberately NOT part of `npm test` (its .mjs extension keeps it out of test/*.test.mts); the prover
 * runs it via --file so its own tests never spawn a nested run of the real suite.
 */
import { test } from "node:test";

test("verify fixture passes one", () => {});

test("verify fixture skips one", { skip: true }, () => {});

// A bodyless todo prints `ok N - … # TODO` with `# fail 0`: not a proof either.
test("verify fixture todo one", { todo: true }, () => {});

// The metacharacters in this name only match literally when the prover escapes the pattern.
test("verify fixture regex (a+b)", () => {});

test("verify fixture fails one", () => {
  throw new Error("fixture red on purpose");
});
