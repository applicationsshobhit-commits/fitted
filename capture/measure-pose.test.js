import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_PARTS, POSE_POINTS, labelFor } from './bodyparts.js';
import { poseFrameMetrics, summarizePose, tapeMeasurements, buildBodyProfile } from './measure-pose.js';

const near = (a, e, tol = 0.5) => assert.ok(Math.abs(a - e) <= tol, `expected ${e}, got ${a}`);

/** A right leg seen from the side, in metres: thigh 0.45 m, shin 0.40 m, knee bent by `bend` degrees. */
function leg(bend) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
  const p = POSE_POINTS.right;
  const rad = bend * Math.PI / 180;
  lm[p.hip] = { x: 0, y: 0, z: 0, visibility: 0.9 };
  lm[p.knee] = { x: 0, y: 0.45, z: 0, visibility: 0.9 };
  lm[p.ankle] = { x: 0.40 * Math.sin(rad), y: 0.45 + 0.40 * Math.cos(rad), z: 0, visibility: 0.9 };
  return lm;
}

// Image landmarks are normalised; with a 1000×1000 frame, 1 world metre maps to 1000 px here.
const frame = (bend, pxPerMm = null) => {
  const w = leg(bend);
  return poseFrameMetrics(BODY_PARTS.knee, 'right', { landmarks: w, worldLandmarks: w, width: 1000, height: 1000, pxPerMm });
};

test('knee bend is 0 for a straight leg and follows the angle', () => {
  near(frame(0).angles.kneeBend, 0);
  near(frame(90).angles.kneeBend, 90);
  near(frame(120).angles.kneeBend, 120);
});

test('lengths come out in millimetres', () => {
  const m = frame(30);
  near(m.lengths.thighLength, 450);
  near(m.lengths.shinLength, 400);
  assert.equal(m.scaleMethod, 'estimated');
});

test('calibration rescales lengths but not angles', () => {
  // 2 px per mm means the 450 px thigh in the image is really 225 mm.
  const m = frame(60, 2);
  assert.equal(m.scaleMethod, 'reference');
  near(m.lengths.thighLength, 225);
  near(m.angles.kneeBend, 60);
});

test('a hidden joint drops the frame', () => {
  const w = leg(30);
  w[POSE_POINTS.right.ankle].visibility = 0.1;
  assert.equal(poseFrameMetrics(BODY_PARTS.knee, 'right', { landmarks: w, worldLandmarks: w, width: 1000, height: 1000 }), null);
});

test('summary gives a range of motion across the recording', () => {
  const frames = [];
  for (let b = 5; b <= 125; b += 5) frames.push(frame(b));
  frames.push(null);
  const s = summarizePose(BODY_PARTS.knee, frames);
  assert.equal(s.trackedFrames, 25);
  assert.ok(s.angles.kneeBend.min < 15 && s.angles.kneeBend.max > 115);
});

test('tape readings convert from cm and inches; blanks are dropped', () => {
  const t = tapeMeasurements([{ key: 'kneeCircumference', value: '38.5' }, { key: 'calfCircumference', value: '' }], 'cm');
  assert.deepEqual(Object.keys(t), ['kneeCircumference']);
  assert.equal(t.kneeCircumference.value, 385);
  assert.equal(tapeMeasurements([{ key: 'x', value: '10' }], 'in').x.value, 254);
});

test('tape wins over camera for the same measurement, keeping both', () => {
  const s = summarizePose(BODY_PARTS.ankle, []) ;
  assert.equal(s, null);
  const p = buildBodyProfile({
    bodyPart: 'ankle', side: 'left', source: 'video',
    summary: { scaleMethod: 'estimated', scaleSpreadPct: null, lengths: { footLength: 250, shinLength: 400 }, angles: { ankleAngle: { min: 70, max: 120 } }, frames: 10, trackedFrames: 9 },
    tape: { footLength: { value: 240, unit: 'mm', source: 'tape' } },
  });
  assert.equal(p.measurements.footLength.value, 240);
  assert.equal(p.measurements.footLength.camera, 250);
  assert.equal(p.motion.ankleAngle.unit, 'deg');
});

test('a tape-only profile for "other" carries its description', () => {
  const p = buildBodyProfile({ bodyPart: 'other', side: 'none', description: 'neck support', tape: tapeMeasurements([{ key: 'neckCircumference', value: '34', label: 'Around the neck' }]) });
  assert.equal(p.scale.method, 'tape');
  assert.equal(p.description, 'neck support');
  assert.equal(p.measurements.neckCircumference.label, 'Around the neck');
});

test('every pose body part names points, lengths and angles that exist', () => {
  for (const [id, def] of Object.entries(BODY_PARTS)) {
    if (def.tracker !== 'pose') continue;
    for (const pt of def.points) assert.ok(POSE_POINTS.right[pt] !== undefined, `${id}: ${pt}`);
    for (const [a, b] of Object.values(def.lengths)) assert.ok(def.points.includes(a) && def.points.includes(b), id);
    for (const a of Object.values(def.angles)) assert.ok([a.at, a.from, a.to].every(p => def.points.includes(p)), id);
  }
  assert.equal(labelFor('kneeCircumference'), 'Around the knee');
});

import { scalePoseSummary } from './measure-pose.js';
import { scaleHandSummary } from './measure.js';

test('one measured length rescales every length, not angles', () => {
  const s = { scaleMethod: 'estimated', scaleSpreadPct: null, lengths: { thighLength: 450, shinLength: 400 }, angles: { kneeBend: { min: 5, max: 110 } }, frames: 10, trackedFrames: 10 };
  const out = scalePoseSummary(s, 'shinLength', 360);
  near(out.lengths.shinLength, 360);
  near(out.lengths.thighLength, 405);
  assert.equal(out.angles.kneeBend.max, 110);
  assert.equal(out.scaleMethod, 'measured');
});

test('hand: measured hand length rescales sizes and opening', () => {
  const s = { scaleMethod: 'estimated', scaleSpreadPct: null, sizes: { knuckleSpan: 70, palmLength: 100, handLength: 200, fingerLength: { index: 80 } }, motion: { aperture: { min: 20, max: 100 }, curl: {} }, frames: 10, handFrames: 10 };
  const out = scaleHandSummary(s, 'handLength', 160);
  near(out.sizes.knuckleSpan, 56);
  near(out.motion.aperture.max, 80);
  near(out.sizes.fingerLength.index, 64);
  assert.equal(s.sizes.knuckleSpan, 70, 'original untouched');
});

test('every filmed body part names a length to calibrate with', () => {
  for (const [id, d] of Object.entries(BODY_PARTS)) {
    if (d.tracker === 'pose') assert.ok(d.lengths[d.calibrateWith?.key], id);
    if (d.tracker === 'hand') assert.equal(d.calibrateWith.key, 'handLength');
  }
});
