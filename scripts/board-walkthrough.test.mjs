import "./test-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { camera, refuseLocalText, VIEW } from "./board-walkthrough.mjs";

const seen = ({ s, tx, ty }) => ({ left: -tx / s, top: -ty / s, right: (VIEW.width - tx) / s, bottom: (VIEW.height - ty) / s });

test("T1166: the zoom centres its target when it can, and never shows past an edge of the page", () => {
  const middle = seen(camera({ x: 600, y: 350, w: 120, h: 100 }, 1.5));
  assert.deepEqual([Math.round((middle.left + middle.right) / 2), Math.round((middle.top + middle.bottom) / 2)], [660, 400], "a target in the middle is in the middle of the view");
  for (const rect of [{ x: 0, y: 0, w: 40, h: 40 }, { x: 1280, y: 760, w: 40, h: 40 }, { x: 1300, y: 10, w: 20, h: 20 }]) {
    const view = seen(camera(rect, 1.45));
    assert.ok(view.left >= 0 && view.top >= 0 && view.right <= VIEW.width && view.bottom <= VIEW.height, `${JSON.stringify(rect)}: the view ${JSON.stringify(view)} stays on the page`);
    assert.ok(view.left <= rect.x && view.top <= rect.y && view.right >= rect.x + rect.w && view.bottom >= rect.y + rect.h, `${JSON.stringify(rect)}: the target is in the view`);
  }
});

test("T1166: a frame that shows a local path or the login name stops the walkthrough", () => {
  const words = ["/tmp/sage-walkthrough-x", "/home/someone", "someone"];
  assert.throws(() => refuseLocalText("Overview\nSaved in /home/someone/project", words), /local text "\/home\/someone"/);
  assert.throws(() => refuseLocalText("chief someone · C1", words), /local text "someone"/);
  assert.doesNotThrow(() => refuseLocalText("Overview\nchief Claude · C1\nT10 · Sample sync design", words));
});
