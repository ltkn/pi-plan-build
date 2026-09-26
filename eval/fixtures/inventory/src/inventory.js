/** Stock levels per SKU, in memory. */
export class Inventory {
  #stock = new Map();

  /** Add `qty` units of `sku` to the stock. */
  receive(sku, qty) {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(`quantity must be a positive integer, got ${qty}`);
    this.#stock.set(sku, this.available(sku) + qty);
  }

  /** Units of `sku` that can be sold. */
  available(sku) {
    return this.#stock.get(sku) ?? 0;
  }

  /** Remove `qty` units of `sku` from the stock. */
  ship(sku, qty) {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(`quantity must be a positive integer, got ${qty}`);
    if (qty > this.available(sku)) throw new Error(`not enough ${sku}: ${this.available(sku)} available, ${qty} requested`);
    this.#stock.set(sku, this.available(sku) - qty);
  }
}
