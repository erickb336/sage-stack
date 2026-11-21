import "./test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { camera, encode, ffmpegCommand, refuseLocalText, VIEW } from "./board-walkthrough.mjs";

const SCRIPT = fileURLToPath(new URL("./board-walkthrough.mjs", import.meta.url));
const ffmpeg = (() => { try { return ffmpegCommand().ffmpeg; } catch { return null; } })();

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

test("F-T1187-2: the tour is dark only: --tour --theme light says so and records nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-walk-theme-"));
  try {
    const run = spawnSync(process.execPath, [SCRIPT, "--tour", "--theme", "light", "--frames", join(dir, "frames")], { encoding: "utf8", env: { ...process.env, FFMPEG: join(dir, "no-ffmpeg") } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /the tour is dark only/);
    assert.equal(existsSync(join(dir, "frames")), false, "no frames: the run stops before the browser");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-T1187-1 and F-T1187-4: one RGBA frame among RGB frames loses no frame and no caption bar in the video", { skip: !ffmpeg && "needs ffmpeg 6 or later" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-walk-encode-")), count = 120, make = (args) => assert.equal(spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]).status, 0);
  try {
    for (const name of ["frames", "captions"]) mkdirSync(join(dir, name));
    make(["-f", "lavfi", "-i", `color=c=0x203040:s=${VIEW.width}x${VIEW.height}:r=20`, "-frames:v", String(count), "-start_number", "0", join(dir, "frames", "%04d.png")]);
    make(["-f", "lavfi", "-i", `color=c=0x203040:s=${VIEW.width}x${VIEW.height}`, "-vf", "format=rgba,geq=r=32:g=48:b=64:a='if(eq(Y,52),0,255)'", "-frames:v", "1", join(dir, "frames", "0060.png")]);
    make(["-f", "lavfi", "-i", `color=c=white:s=${VIEW.width}x52:r=20`, "-frames:v", String(count), "-start_number", "0", join(dir, "captions", "%04d.png")]);
    make(["-f", "lavfi", "-i", "color=c=black:s=1376x944", "-vf", "format=rgba,geq=r=0:g=0:b=0:a=0", "-frames:v", "1", join(dir, "window.png")]);
    const out = join(dir, "tour.mp4");
    encode({ ffmpeg, tour: true, frames: join(dir, "frames"), captions: join(dir, "captions"), window: join(dir, "window.png"), out });
    const stats = spawnSync(ffmpeg, ["-hide_banner", "-i", out, "-vf", "crop=700:30:340:876,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { encoding: "utf8" });
    const bars = [...stats.stdout.matchAll(/YAVG=([\d.]+)/g)].map(match => Number(match[1]));
    assert.equal(bars.length, count, "the video has every frame that the recorder took");
    assert.deepEqual(bars.map((luma, frame) => luma > 200 ? null : frame).filter(frame => frame !== null), [], "every frame shows the white caption bar");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
