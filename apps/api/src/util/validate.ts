import type { z } from "zod";
import { badRequest } from "../errors.js";

/** Parse with a zod schema, converting failures into a 400 `ApiError`. */
export function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what = "body"): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(`invalid ${what}`, r.error.flatten());
  }
  return r.data;
}
