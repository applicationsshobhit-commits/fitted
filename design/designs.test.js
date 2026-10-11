import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designFromProfile } from './designs.js';
import { buildAll, measure } from './export.js';

const near = (a, e, tol, msg) => assert.ok(Math.abs(a - e) <= tol, `${msg ?? ''} expected ${e} ±${tol}, got ${a}`);

function profile({ span = 70, palm = 95, open = 80, method = 'reference' } = {}) {
  return {
    schema: 'fitted.body-profile/v1',
    bodyPart: 'hand',
    scale: { method },
    measurements: { knuckleSpan: { value: span, unit: 'mm' }, palmLength: { value: palm, unit: 'mm' } },
    motion: { aperture: { min: 10, max: open, unit: 'mm' } },
  };
}

test('sizes follow the profile and stay in safe ranges', () => {
  const p = designFromProfile(profile({ open: 80 }));
  assert.equal(p.builtUp.outerDiameter, 40);
  assert.equal(designFromProfile(profile({ open: 20 })).builtUp.outerDiameter, 22, 'clamped at minimum');
  assert.equal(designFromProfile(profile({ open: 200 })).builtUp.outerDiameter, 46, 'clamped at maximum');
  assert.equal(p.builtUp.length, Math.round(70 * 1.2 + 15));
  assert.equal(p.cuff.palmWidth, Math.round(70 * 1.2 + 6));
  assert.equal(p.bulb.diameter, Math.round(95 * 0.55));
  assert.equal(p.estimated, false);
  assert.equal(designFromProfile(profile({ method: 'estimated' })).estimated, true);
  for (const part of [p.builtUp, p.cuff, p.bulb]) assert.ok(part.why, 'every design explains its numbers');
});

test('the printed grip has the diameter and length that were asked for', () => {
  const { params, parts } = buildAll(profile({ open: 80 }));
  const m = measure(parts['built-up-grip']);
  near(m.sizeMm[0], params.builtUp.length, 0.5, 'length along X');
  near(m.sizeMm[1], params.builtUp.outerDiameter, params.builtUp.outerDiameter * 0.03, 'diameter');
  near(m.sizeMm[1], m.sizeMm[2], 0.5, 'round');
  assert.ok(m.volumeCm3 > 0);
});

test('the grip is hollow: its volume is less than a solid of the same outline', () => {
  const { params, parts } = buildAll(profile({ open: 80 }));
  const m = measure(parts['built-up-grip']);
  const solidCm3 = Math.PI * (params.builtUp.outerDiameter / 2) ** 2 * params.builtUp.length / 1000;
  const boreCm3 = Math.PI * (params.builtUp.boreDiameter / 2) ** 2 * params.builtUp.length / 1000;
  assert.ok(m.volumeCm3 < solidCm3, 'no more than a full cylinder');
  assert.ok(m.volumeCm3 < solidCm3 - boreCm3 * 0.9, 'the bore is really there');
});

test('the cuff wraps the palm with the measured clearance', () => {
  const { params, parts } = buildAll(profile());
  const [band] = parts['universal-cuff'];
  band.computeBoundingBox();
  const width = band.boundingBox.max.x - band.boundingBox.min.x;
  near(width, params.cuff.palmWidth + 2 * params.cuff.wall, 0.5, 'band outer width');
  near(band.boundingBox.max.z - band.boundingBox.min.z, params.cuff.bandWidth, 0.01, 'band width');
});

test('the bulb is as wide as asked', () => {
  const { params, parts } = buildAll(profile());
  const m = measure(parts['palm-bulb']);
  near(m.sizeMm[1], params.bulb.diameter, params.bulb.diameter * 0.04, 'bulb diameter');
});
