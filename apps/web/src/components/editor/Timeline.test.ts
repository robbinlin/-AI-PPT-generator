import { describe, expect, it } from "vitest";
import { MAX_TAIL_PAUSE_SEC } from "@lvs/shared";
import { tailAfterDrag } from "./Timeline";

describe("tailAfterDrag", () => {
  it("turns the dragged pixels into tail-pause seconds, rounded to 0.1 s", () => {
    expect(tailAfterDrag(0.5, 100, 20)).toEqual({ tail: 5.5 });
    expect(tailAfterDrag(3, -43, 20)).toEqual({ tail: 0.9 });
  });
  it("stops at the narration (tail 0) and at the maximum hold, flagging the limit", () => {
    expect(tailAfterDrag(0.5, -300, 20)).toEqual({ tail: 0, limit: "min" });
    expect(tailAfterDrag(0.5, 99_999, 20)).toEqual({ tail: MAX_TAIL_PAUSE_SEC, limit: "max" });
  });
});
