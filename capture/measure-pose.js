// Limb measurement from MediaPipe Pose landmarks, for every body part in
// bodyparts.js with tracker 'pose'. No browser dependencies, so it is tested
// the same way as measure.js.
//
// Like the hand: lengths come from the 3D world landmarks (metres, scaled to an
// average body), and one calibration against a card converts them to this
// person's millimetres. Angles need no calibration at all, which is why range
// of motion is the strongest thing a camera measures.
import { POSE_POINTS } from './bodyparts.js';
import { angleAt, dist2, dist3, percentile } from './measure.js';

/** Below this, MediaPipe is guessing where the point is (often off-screen). */
export const MIN_VISIBILITY = 0.5;

/**
 * Measurements for one frame, or null if a needed point isn't visible.
 * `def` is a BODY_PARTS entry; `side` is 'left' or 'right'.
 */
export function poseFrameMetrics(def, side, { landmarks, worldLandmarks, width, height, pxPerMm = null }) {
  const idx = POSE_POINTS[side] || POSE_POINTS.right;
  for (const name of def.points) {
    if ((landmarks[idx[name]]?.visibility ?? 1) < MIN_VISIBILITY) return null;
  }
  const img = name => ({ x: landmarks[idx[name]].x * width, y: landmarks[idx[name]].y * height });
  const w = name => { const l = worldLandmarks[idx[name]]; return { x: l.x * 1000, y: l.y * 1000, z: l.z * 1000 }; };

  // Calibrate on the first length: filmed from the side, that limb segment lies
  // roughly flat to the camera, so its length in the image is close to true.
  const [refKey, [ra, rb]] = Object.entries(def.lengths)[0];
  const refWorld = dist3(w(ra), w(rb));
  let scale = 1, scaleMethod = 'estimated';
  if (pxPerMm && refWorld > 0) {
    scale = (dist2(img(ra), img(rb)) / pxPerMm) / refWorld;
    scaleMethod = 'reference';
  }

  const lengths = {};
  for (const [key, [a, b]] of Object.entries(def.lengths)) lengths[key] = dist3(w(a), w(b)) * scale;

  const angles = {};
  for (const [key, a] of Object.entries(def.angles)) {
    const inside = angleAt(w(a.from), w(a.at), w(a.to));
    angles[key] = a.kind === 'bend' ? 180 - inside : inside;
  }
  return { scale, scaleMethod, refKey, lengths, angles };
}

/** Combine frames: median for lengths, 5th–95th percentile for angles. */
export function summarizePose(def, frames) {
  const ok = frames.filter(Boolean);
  if (!ok.length) return null;
  const methods = new Set(ok.map(f => f.scaleMethod));
  const scaleMethod = methods.size === 1 ? [...methods][0] : 'mixed';
  const scales = ok.map(f => f.scale);
  const scaleMed = percentile(scales, 50);
  return {
    scaleMethod,
    scaleSpreadPct: scaleMethod === 'reference' && scaleMed ? ((percentile(scales, 90) - percentile(scales, 10)) / scaleMed) * 100 : null,
    lengths: Object.fromEntries(Object.keys(def.lengths).map(k => [k, percentile(ok.map(f => f.lengths[k]), 50)])),
    angles: Object.fromEntries(Object.keys(def.angles).map(k => [k, { min: percentile(ok.map(f => f.angles[k]), 5), max: percentile(ok.map(f => f.angles[k]), 95) }])),
    frames: frames.length,
    trackedFrames: ok.length,
  };
}

const r1 = v => Math.round(v * 10) / 10;

/** Calibrate with one length measured by hand; every length scales to match it. */
export function scalePoseSummary(summary, key, mm) {
  const now = summary.lengths[key];
  if (!(mm > 0) || !(now > 0)) return summary;
  const f = mm / now;
  return {
    ...summary,
    lengths: Object.fromEntries(Object.entries(summary.lengths).map(([k, v]) => [k, v * f])),
    scaleMethod: 'measured',
    scaleSpreadPct: null,
  };
}

/**
 * Tape readings, entered in cm or inches, as {key: {value, unit:'mm', source:'tape'}}.
 * Blank and non-numeric entries are dropped.
 */
export function tapeMeasurements(entries, unit = 'cm') {
  const factor = unit === 'in' ? 25.4 : 10;
  const out = {};
  for (const { key, value, label } of entries) {
    const v = Number(String(value).replace(',', '.'));
    if (!key || !Number.isFinite(v) || v <= 0) continue;
    out[key] = { value: r1(v * factor), unit: 'mm', source: 'tape', ...(label ? { label } : {}) };
  }
  return out;
}

/**
 * The shared body profile for any body part. Camera lengths and tape readings
 * share `measurements`; where both measure the same thing, the tape wins and
 * the camera's value is kept alongside for comparison.
 */
export function buildBodyProfile({ bodyPart, side, source, reference = null, summary = null, tape = {}, description = '' }) {
  const measurements = {};
  if (summary) {
    for (const [k, v] of Object.entries(summary.lengths)) measurements[k] = { value: r1(v), unit: 'mm', source: 'camera' };
  }
  for (const [k, v] of Object.entries(tape)) {
    measurements[k] = measurements[k] ? { ...v, camera: measurements[k].value } : v;
  }
  return {
    schema: 'fitted.body-profile/v1',
    bodyPart,
    side,
    source: summary ? source : 'tape',
    capturedAt: new Date().toISOString(),
    ...(description ? { description } : {}),
    scale: summary
      ? { method: summary.scaleMethod, reference, spreadPct: summary.scaleSpreadPct == null ? null : r1(summary.scaleSpreadPct) }
      : { method: Object.keys(tape).length ? 'tape' : 'none', reference: null, spreadPct: null },
    measurements,
    motion: summary
      ? Object.fromEntries(Object.entries(summary.angles).map(([k, r]) => [k, { min: r1(r.min), max: r1(r.max), unit: 'deg' }]))
      : {},
    quality: summary ? { frames: summary.frames, trackedFrames: summary.trackedFrames } : { frames: 0, trackedFrames: 0 },
  };
}
