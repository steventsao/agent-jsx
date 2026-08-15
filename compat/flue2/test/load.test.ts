/** The generated flue 2.0 module loads against the REAL @flue/runtime 2.0.x —
 *  its hook imports resolve and the default export is the agent function the
 *  session would re-render every turn. Executing a render requires flue's
 *  per-render frame; root unit tests drive renders through a recording
 *  session harness instead. */
import { expect, it } from "bun:test";
import Oncall from "../src/generated/oncall.flue2.ts";

it("emits a loadable flue 2.0 function agent", () => {
  expect(typeof Oncall).toBe("function");
  expect(Oncall.name).toBe("Oncall");
});
