import assert from "node:assert/strict";
import { test } from "node:test";
import { Inventory } from "../src/inventory.js";

test("receive adds stock", () => {
  const inv = new Inventory();
  inv.receive("apple", 3);
  inv.receive("apple", 2);
  assert.equal(inv.available("apple"), 5);
});

test("ship removes stock and refuses more than there is", () => {
  const inv = new Inventory();
  inv.receive("apple", 3);
  inv.ship("apple", 2);
  assert.equal(inv.available("apple"), 1);
  assert.throws(() => inv.ship("apple", 2), /not enough apple/);
});
