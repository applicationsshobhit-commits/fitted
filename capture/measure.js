// Hand measurement from MediaPipe landmarks.
//
// MediaPipe returns two views of the same 21 points:
//   - image landmarks: normalized to the frame, so they know where the hand is in pixels
//   - world landmarks: 3D, in metres, but scaled to an average adult hand
// Lengths are taken from the 3D view, which is immune to fingers curling toward the
// camera, and corrected to real millimetres with one calibration: the knuckle span
// measured in the image against a reference object of known size.

const WRIST = 0;
const KNUCKLE_A = 5; // index MCP
const KNUCKLE_B = 17; // pinky MCP

export const FINGERS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};
const LONG_FINGERS = ['index', 'middle', 'ring', 'pinky'];

export const REFERENCES = {
  card: { label: 'Bank card, long edge', mm: 85.6 },
  cardShort: { label: 'Bank card, short edge', mm: 53.98 },
  quarter: { label: 'US quarter, diameter', mm: 24.26 },
};

// ---------- vector helpers ----------
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = a => Math.hypot(a.x, a.y, a.z);
const unit = a => { const n = norm(a); return n ? { x: a.x / n, y: a.y / n, z: a.z / n } : a; };
const DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3 = (a, b) => norm(sub(a, b));

/** Angle at b, in degrees, between b→a and b→c. */
export function angleAt(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const n = norm(u) * norm(v);
  return n ? Math.acos(clamp(dot(u, v) / n, -1, 1)) * DEG : 0;
}

/** How far a joint is bent: 0 when a-b-c is a straight line. */
export const bendAt = (a, b, c) => 180 - angleAt(a, b, c);

/** Pixels per millimetre from two clicked points on a reference of known length. */
export function pxPerMmFrom(p1, p2, mm) {
  const px = dist2(p1, p2);
  if (!(mm > 0)) throw new Error('Reference length must be greater than zero.');
  if (px < 10) throw new Error('The two points are too close together. Click both ends of the reference.');
  return px / mm;
}

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const i = (v.length - 1) * (p / 100);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

/**
 * Measurements for one video frame.
 * Returns millimetres and degrees. `scaleMethod` is 'reference' once calibrated,
 * otherwise 'estimated' (MediaPipe's average-hand scale, wrong for children).
 */
export function frameMetrics({ landmarks, worldLandmarks, width, height, pxPerMm = null }) {
  const img = landmarks.map(l => ({ x: l.x * width, y: l.y * height }));
  const w = worldLandmarks.map(l => ({ x: l.x * 1000, y: l.y * 1000, z: l.z * 1000 }));

  const spanWorld = dist3(w[KNUCKLE_A], w[KNUCKLE_B]);
  let scale = 1, scaleMethod = 'estimated';
  if (pxPerMm && spanWorld > 0) {
    // The knuckle span is rigid and roughly parallel to the camera when the palm faces it.
    scale = (dist2(img[KNUCKLE_A], img[KNUCKLE_B]) / pxPerMm) / spanWorld;
    scaleMethod = 'reference';
  }

  const len = (i, j) => dist3(w[i], w[j]) * scale;
  const pathLen = idx => idx.slice(1).reduce((sum, j, k) => sum + len(idx[k], j), 0);

  // Palm plane normal: knuckle-to-flexion is measured as rotation out of this plane,
  // so fingers spreading sideways is not mistaken for curling.
  const palmNormal = unit(cross(sub(w[KNUCKLE_A], w[WRIST]), sub(w[KNUCKLE_B], w[WRIST])));

  const fingerLength = {}, curl = {};
  for (const [name, idx] of Object.entries(FINGERS)) {
    // Thumb length is from its MCP; its metacarpal sits inside the palm.
    fingerLength[name] = name === 'thumb' ? pathLen(idx.slice(1)) : pathLen(idx);
    const [a, b, c, d] = idx.map(i => w[i]);
    if (name === 'thumb') {
      curl[name] = bendAt(a, b, c) + bendAt(b, c, d);
    } else {
      const mcpFlex = Math.asin(clamp(Math.abs(dot(unit(sub(b, a)), palmNormal)), 0, 1)) * DEG;
      curl[name] = mcpFlex + bendAt(a, b, c) + bendAt(b, c, d);
    }
  }

  return {
    scale,
    scaleMethod,
    knuckleSpan: spanWorld * scale,
    palmLength: len(WRIST, 9),
    handLength: len(WRIST, 9) + pathLen(FINGERS.middle),
    fingerLength,
    aperture: len(4, 8), // thumb tip to index tip
    curl,
  };
}

/**
 * Combine frames into one summary. Rigid sizes use the median; motion uses the
 * 5th–95th percentile so a single bad frame can't set the range.
 * `frames` may contain null for frames where no hand was found.
 */
export function summarize(frames) {
  const ok = frames.filter(Boolean);
  if (!ok.length) return null;
  const med = pick => percentile(ok.map(pick), 50);
  const range = pick => ({ min: percentile(ok.map(pick), 5), max: percentile(ok.map(pick), 95) });

  const methods = new Set(ok.map(f => f.scaleMethod));
  const scaleMethod = methods.size === 1 ? [...methods][0] : 'mixed';
  const scales = ok.map(f => f.scale);
  const scaleMed = percentile(scales, 50);
  const scaleSpreadPct = scaleMethod === 'reference' && scaleMed
    ? ((percentile(scales, 90) - percentile(scales, 10)) / scaleMed) * 100
    : null;

  return {
    scaleMethod,
    scaleSpreadPct,
    sizes: {
      knuckleSpan: med(f => f.knuckleSpan),
      palmLength: med(f => f.palmLength),
      handLength: med(f => f.handLength),
      fingerLength: Object.fromEntries(Object.keys(FINGERS).map(n => [n, med(f => f.fingerLength[n])])),
    },
    motion: {
      aperture: range(f => f.aperture),
      curl: Object.fromEntries(Object.keys(FINGERS).map(n => [n, range(f => f.curl[n])])),
    },
    frames: frames.length,
    handFrames: ok.length,
  };
}

const r1 = v => Math.round(v * 10) / 10;
const mm = v => ({ value: r1(v), unit: 'mm' });
const span = (r, u) => ({ min: r1(r.min), max: r1(r.max), unit: u });

/**
 * The shared body profile. Every body part writes this same shape: named
 * measurements as {value, unit}, named motion ranges as {min, max, unit}.
 * The design side reads profiles without knowing which tracker made them.
 */
export function buildProfile(summary, { side = 'unknown', source = 'unknown', reference = null } = {}) {
  return {
    schema: 'fitted.body-profile/v1',
    bodyPart: 'hand',
    side,
    source,
    capturedAt: new Date().toISOString(),
    scale: {
      method: summary.scaleMethod,
      reference,
      spreadPct: summary.scaleSpreadPct == null ? null : r1(summary.scaleSpreadPct),
    },
    measurements: {
      knuckleSpan: mm(summary.sizes.knuckleSpan),
      palmLength: mm(summary.sizes.palmLength),
      handLength: mm(summary.sizes.handLength),
      ...Object.fromEntries(Object.entries(summary.sizes.fingerLength).map(([n, v]) => [`${n}Length`, mm(v)])),
    },
    motion: {
      aperture: span(summary.motion.aperture, 'mm'),
      ...Object.fromEntries(Object.entries(summary.motion.curl).map(([n, r]) => [`${n}Curl`, span(r, 'deg')])),
    },
    quality: { frames: summary.frames, handFrames: summary.handFrames },
  };
}

/**
 * Suggest a starting design and its settings.
 *
 * DRAFT RULES. The thresholds below are placeholders chosen to exercise the
 * pipeline, not clinical guidance. They must be replaced with sizing rules from
 * occupational therapists before anyone relies on them.
 */
export function recommend(profile) {
  const open = profile.motion.aperture.max;
  const span = profile.measurements.knuckleSpan.value;
  const straightest = Math.min(...LONG_FINGERS.map(n => profile.motion[`${n}Curl`].min));
  const reasons = [];
  const notes = [];

  if (profile.scale.method !== 'reference') notes.push('Sizes are estimated. Calibrate with a card for real millimetres.');
  if (profile.scale.spreadPct != null && profile.scale.spreadPct > 15) notes.push('Calibration varied a lot between frames. Keep the palm facing the camera and re-record.');
  if (profile.quality.handFrames < 30) notes.push('Short recording. Ten seconds or more gives steadier numbers.');

  if (open < 30 || straightest > 90) {
    if (open < 30) reasons.push(`Thumb-to-index opening peaked at ${r1(open)} mm, too small to wrap a handle.`);
    if (straightest > 90) reasons.push(`Fingers never straightened past ${Math.round(straightest)}° of curl.`);
    return {
      design: 'cuff', label: 'Universal cuff',
      params: { palmWidth: clamp(Math.round(span * 1.1), 55, 92) },
      reasons, notes, draft: true,
    };
  }
  reasons.push(`Hand opens to ${r1(open)} mm, enough to wrap a thick handle part of the way.`);
  return {
    design: 'builtUp', label: 'Built-up grip',
    params: { gripDiameter: clamp(Math.round(open * 0.5), 22, 46) },
    reasons, notes, draft: true,
  };
}
