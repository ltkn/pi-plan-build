// Hidden acceptance tests: copied in after the run, never shown to the agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Inventory } from "../src/inventory.js";

test("hidden: a reservation holds stock back from available()", () => {
  const inv = new Inventory();
  inv.receive("pear", 5);
  inv.reserve("pear", 2);
  assert.equal(inv.available("pear"), 3);
});

test("hidden: reserving more than is available throws and changes nothing", () => {
  const inv = new Inventory();
  inv.receive("pear", 1);
  assert.throws(() => inv.reserve("pear", 2));
  assert.equal(inv.available("pear"), 1);
});

test("hidden: shipping a reservation uses the held stock", () => {
  const inv = new Inventory();
  inv.receive("pear", 3);
  const id = inv.reserve("pear", 2);
  inv.shipReservation(id);
  assert.equal(inv.available("pear"), 1);
  assert.throws(() => inv.shipReservation(id));
});

test("hidden: releasing a reservation returns its stock", () => {
  const inv = new Inventory();
  inv.receive("pear", 3);
  const id = inv.reserve("pear", 2);
  inv.release(id);
  assert.equal(inv.available("pear"), 3);
});

test("hidden: ship() can't take reserved stock", () => {
  const inv = new Inventory();
  inv.receive("pear", 3);
  inv.reserve("pear", 2);
  assert.throws(() => inv.ship("pear", 2));
});
