import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameMetrics, summarize, buildProfile, recommend, pxPerMmFrom, percentile, bendAt,
} from './measure.js';

const near = (actual, expected, tol = 0.05, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected}, got ${actual}`);

// A flat right hand in millimetres, palm facing the camera (z = 0), fingers pointing up (−y).
// Options bend the index finger out of the palm plane, at the knuckle or at the middle joint.
function makeHand({ indexMcpFlex = 0, indexPipBend = 0, thumbTip = null } = {}) {
  const p = Array(21);
  p[0] = { x: 0, y: 0, z: 0 };
  p[1] = { x: -30, y: -20, z: 0 };
  p[2] = { x: -50, y: -40, z: 0 };
  p[3] = { x: -65, y: -60, z: 0 };
  p[4] = thumbTip ?? { x: -75, y: -80, z: 0 };
  const mcps = { 5: -30, 9: -10, 13: 10, 17: 30 };
  const mcpY = { 5: -90, 9: -95, 13: -90, 17: -85 };
  const dir = deg => ({ y: -Math.cos(deg * Math.PI / 180), z: Math.sin(deg * Math.PI / 180) });
  for (const base of [5, 9, 13, 17]) {
    const mcp = { x: mcps[base], y: mcpY[base], z: 0 };
    const flex = base === 5 ? indexMcpFlex : 0;
    const pipBend = base === 5 ? indexPipBend : 0;
    const d1 = dir(flex), d2 = dir(flex + pipBend);
    const pip = { x: mcp.x, y: mcp.y + 40 * d1.y, z: 40 * d1.z };
    const dip = { x: mcp.x, y: pip.y + 25 * d2.y, z: pip.z + 25 * d2.z };
    const tip = { x: mcp.x, y: dip.y + 20 * d2.y, z: dip.z + 20 * d2.z };
    [p[base], p[base + 1], p[base + 2], p[base + 3]] = [mcp, pip, dip, tip];
  }
  return p;
}

// Project to MediaPipe's two formats: world in metres, image normalized at 2 px per mm.
function toLandmarks(handMm, worldScale = 1) {
  return {
    worldLandmarks: handMm.map(q => ({ x: q.x * worldScale / 1000, y: q.y * worldScale / 1000, z: q.z * worldScale / 1000 })),
    landmarks: handMm.map(q => ({ x: (500 + 2 * q.x) / 1000, y: (500 + 2 * q.y) / 1000, z: 0 })),
    width: 1000,
    height: 1000,
  };
}

test('calibrated sizes come out in real millimetres', () => {
  const m = frameMetrics({ ...toLandmarks(makeHand()), pxPerMm: 2 });
  assert.equal(m.scaleMethod, 'reference');
  near(m.scale, 1, 1e-6, 'scale');
  near(m.knuckleSpan, Math.hypot(60, 5), 0.01, 'knuckle span');
  near(m.fingerLength.index, 85, 0.01, 'index length');
  near(m.fingerLength.thumb, 25 + Math.hypot(10, 20), 0.01, 'thumb length');
  near(m.handLength, Math.hypot(10, 95) + 85, 0.01, 'hand length');
  near(m.aperture, Math.hypot(45, 95), 0.01, 'aperture');
});

test('calibration corrects a world model that assumed the wrong hand size', () => {
  // MediaPipe sizes every hand like an average adult. Here it reports a hand 1.4x too big;
  // the image calibration should pull the numbers back to the true size.
  const m = frameMetrics({ ...toLandmarks(makeHand(), 1.4), pxPerMm: 2 });
  near(m.knuckleSpan, Math.hypot(60, 5), 0.01, 'knuckle span');
  near(m.fingerLength.index, 85, 0.01, 'index length');
});

test('without calibration, sizes are flagged as estimated', () => {
  const m = frameMetrics(toLandmarks(makeHand(), 1.4));
  assert.equal(m.scaleMethod, 'estimated');
  near(m.knuckleSpan, Math.hypot(60, 5) * 1.4, 0.01);
});

test('a straight, flat finger has zero curl', () => {
  const m = frameMetrics({ ...toLandmarks(makeHand()), pxPerMm: 2 });
  for (const f of ['index', 'middle', 'ring', 'pinky']) near(m.curl[f], 0, 0.01, f);
});

test('bending at the middle joint is measured', () => {
  const m = frameMetrics({ ...toLandmarks(makeHand({ indexPipBend: 70 })), pxPerMm: 2 });
  near(m.curl.index, 70, 0.01);
  near(m.curl.middle, 0, 0.01, 'other fingers unaffected');
});

test('bending at the knuckle is measured against the palm, not the screen', () => {
  const m = frameMetrics({ ...toLandmarks(makeHand({ indexMcpFlex: 45 })), pxPerMm: 2 });
  near(m.curl.index, 45, 0.01);
});

test('a curled finger keeps its true length', () => {
  // The image shows the curled finger foreshortened; the 3D path should not shrink.
  const m = frameMetrics({ ...toLandmarks(makeHand({ indexMcpFlex: 40, indexPipBend: 60 })), pxPerMm: 2 });
  near(m.fingerLength.index, 85, 0.01);
});

test('pixels per millimetre from a bank card', () => {
  near(pxPerMmFrom({ x: 0, y: 0 }, { x: 171.2, y: 0 }, 85.6), 2, 1e-9);
  assert.throws(() => pxPerMmFrom({ x: 0, y: 0 }, { x: 3, y: 0 }, 85.6), /too close/);
  assert.throws(() => pxPerMmFrom({ x: 0, y: 0 }, { x: 100, y: 0 }, 0), /greater than zero/);
});

test('percentile interpolates and ignores non-numbers', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([10, 20], 50), 15);
  assert.equal(percentile([5, NaN, 1], 0), 1);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('bendAt is zero for a straight line and 90 for a right angle', () => {
  near(bendAt({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }), 0, 1e-9);
  near(bendAt({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }), 90, 1e-9);
});

test('summary takes the range of motion across frames and skips empty frames', () => {
  const frames = [];
  for (let b = 0; b <= 80; b += 4) frames.push(frameMetrics({ ...toLandmarks(makeHand({ indexPipBend: b })), pxPerMm: 2 }));
  frames.push(null, null);
  const s = summarize(frames);
  assert.equal(s.frames, 23);
  assert.equal(s.handFrames, 21);
  assert.equal(s.scaleMethod, 'reference');
  near(s.sizes.fingerLength.index, 85, 0.01, 'size stable while bending');
  near(s.motion.curl.index.min, 4, 0.01, 'p5 of 0..80 in steps of 4');
  near(s.motion.curl.index.max, 76, 0.01, 'p95 of 0..80 in steps of 4');
  near(s.scaleSpreadPct, 0, 1e-6);
});

test('summary of no hands is null', () => {
  assert.equal(summarize([null, null]), null);
});

test('profile follows the shared schema', () => {
  const frames = Array.from({ length: 40 }, () => frameMetrics({ ...toLandmarks(makeHand()), pxPerMm: 2 }));
  const p = buildProfile(summarize(frames), { side: 'right', source: 'video', reference: { label: 'Bank card, long edge', mm: 85.6 } });
  assert.equal(p.schema, 'fitted.body-profile/v1');
  assert.equal(p.bodyPart, 'hand');
  assert.deepEqual(p.measurements.indexLength, { value: 85, unit: 'mm' });
  assert.equal(p.motion.aperture.unit, 'mm');
  assert.equal(p.motion.indexCurl.unit, 'deg');
  for (const v of Object.values(p.measurements)) assert.deepEqual(Object.keys(v).sort(), ['unit', 'value']);
  for (const v of Object.values(p.motion)) assert.deepEqual(Object.keys(v).sort(), ['max', 'min', 'unit']);
});

test('a hand that opens wide gets a built-up grip sized from its opening', () => {
  const frames = Array.from({ length: 40 }, () => frameMetrics({ ...toLandmarks(makeHand()), pxPerMm: 2 }));
  const rec = recommend(buildProfile(summarize(frames)));
  assert.equal(rec.design, 'builtUp');
  assert.equal(rec.params.gripDiameter, 46, 'opening of ~105 mm clamps to the 46 mm maximum');
  assert.equal(rec.draft, true);
});

test('a hand that barely opens gets a cuff', () => {
  // Thumb tip parked next to the index tip: the opening never exceeds a few millimetres.
  const frames = Array.from({ length: 40 }, () => {
    const h = makeHand({ thumbTip: { x: -28, y: -170, z: 0 } });
    return frameMetrics({ ...toLandmarks(h), pxPerMm: 2 });
  });
  const rec = recommend(buildProfile(summarize(frames)));
  assert.equal(rec.design, 'cuff');
  assert.equal(rec.params.palmWidth, Math.round(Math.hypot(60, 5) * 1.1));
});

test('estimated scale and short recordings produce warnings', () => {
  const frames = Array.from({ length: 10 }, () => frameMetrics(toLandmarks(makeHand())));
  const rec = recommend(buildProfile(summarize(frames)));
  assert.ok(rec.notes.some(n => /estimated/i.test(n)));
  assert.ok(rec.notes.some(n => /short recording/i.test(n)));
});
