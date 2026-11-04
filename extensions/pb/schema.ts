/** Tool-parameter schemas: TypeBox, the same package Pi 1.5+ hands its extensions for `typebox`. */
import { type TUnsafe, Type } from "typebox";

export { Type };

/** A string enum schema compatible with providers that reject anyOf/const patterns: `{ type: "string", enum: [...] }`. */
export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
  return Type.Unsafe({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  }) as TUnsafe<T[number]>;
}
