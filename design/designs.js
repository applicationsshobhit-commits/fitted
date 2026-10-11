// Turn a body profile into printable designs. Units are millimetres throughout,
// so the same geometry feeds both the renders and the STL files.
//
// Every number derived from the profile goes through `designFromProfile`. Its
// rules are DRAFTS chosen to exercise the pipeline, not clinical guidance; they
// must be replaced with sizing rules from occupational therapists.
import * as THREE from 'three';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r = v => Math.round(v);

export const DEFAULTS = {
  boreDiameter: 9,      // fits a typical spoon or fork handle; TPU grips it by friction
  bandWidth: 35,        // cuff strap width
  wall: 3.5,            // cuff wall thickness
  slotWidth: 11,        // cuff pocket opening for a utensil handle
  slotHeight: 3.5,
  neckAngle: 20,        // wrist angle isn't measured yet, so the bulb uses a default
};

/** Sizes for all three designs, with the reasoning shown for each number. */
export function designFromProfile(profile) {
  const m = profile.measurements;
  const span = m.knuckleSpan.value;
  const palmLength = m.palmLength.value;
  const opening = profile.motion.aperture.max;
  // The knuckle span runs between joint centres; the hand is wider at the skin.
  const handBreadth = span * 1.2;
  const estimated = profile.scale?.method !== 'reference';

  return {
    estimated,
    builtUp: {
      outerDiameter: clamp(r(opening * 0.5), 22, 46),
      length: clamp(r(handBreadth + 15), 70, 120),
      boreDiameter: DEFAULTS.boreDiameter,
      why: {
        outerDiameter: `half the widest thumb-to-index opening (${opening.toFixed(1)} mm), kept within 22–46 mm`,
        length: `hand breadth (~${r(handBreadth)} mm) plus 15 mm, so every finger lands on the grip`,
      },
    },
    cuff: {
      palmWidth: clamp(r(handBreadth + 6), 50, 100),
      palmThickness: clamp(r(span * 0.4), 18, 35),
      bandWidth: DEFAULTS.bandWidth,
      wall: DEFAULTS.wall,
      slotWidth: DEFAULTS.slotWidth,
      slotHeight: DEFAULTS.slotHeight,
      why: {
        palmWidth: `hand breadth (~${r(handBreadth)} mm) plus 3 mm clearance each side`,
        palmThickness: 'estimated from knuckle span; a side-on video would measure it properly',
      },
    },
    bulb: {
      diameter: clamp(r(palmLength * 0.55), 40, 68),
      boreDiameter: DEFAULTS.boreDiameter,
      neckAngle: DEFAULTS.neckAngle,
      why: {
        diameter: `55% of palm length (${palmLength.toFixed(1)} mm), so the palm wraps it`,
        neckAngle: 'default; wrist angle is not measured yet',
      },
    },
  };
}

// A closed profile revolved around Y: outer surface up, flat end, bore down.
// Revolving a closed loop gives a solid with a hole through it.
function sleeve(outerProfile, bore) {
  const ri = bore / 2;
  const L = outerProfile[outerProfile.length - 1][1];
  const pts = [[ri, 0], ...outerProfile, [ri, L], [ri, 0]];
  const geo = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 96);
  geo.computeVertexNormals();
  return geo;
}

/** Built-up grip: a ribbed sleeve, axis along +X, starting at x = 0. */
export function builtUpGeometry({ outerDiameter, length, boreDiameter }) {
  const R = outerDiameter / 2, minR = boreDiameter / 2 + 2, N = 120, prof = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let rad = R * (0.92 + 0.08 * Math.sin(Math.PI * t));
    rad *= 1 - 0.045 * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * 7 * t), 14);   // finger ribs
    const e = Math.min(1, t / 0.08, (1 - t) / 0.08);                              // rounded ends
    rad = Math.max(minR, rad * (0.62 + 0.38 * Math.sin(e * Math.PI / 2)));
    prof.push([rad, t * length]);
  }
  const geo = sleeve(prof, boreDiameter);
  geo.rotateZ(-Math.PI / 2);   // revolve axis Y → X
  return geo;
}

/** Palm bulb: an egg-shaped sleeve that fills the palm, axis along +X. */
export function bulbGeometry({ diameter, boreDiameter }) {
  const R = diameter / 2, L = diameter * 1.25, minR = boreDiameter / 2 + 1.5, N = 100;
  // Egg shape, fuller at the back. Normalised so its widest point is exactly the requested diameter.
  const shape = t => Math.pow(Math.sin(Math.PI * t), 0.72) * (0.86 + 0.14 * t);
  const ts = Array.from({ length: N + 1 }, (_, i) => i / N);
  const peak = Math.max(...ts.map(shape));
  const prof = ts.map(t => [Math.max(minR, R * shape(t) / peak), t * L]);
  const geo = sleeve(prof, boreDiameter);
  geo.rotateZ(-Math.PI / 2);
  return geo;
}

/**
 * Universal cuff: a C-shaped band around the palm (open at the back of the hand
 * so it slips on), plus a pocket on the palm side that holds a utensil handle.
 * Band axis runs along Z (wrist → fingers); the pocket runs across the hand, along X.
 */
export function cuffGeometries({ palmWidth, palmThickness, bandWidth, wall, slotWidth, slotHeight }) {
  const rx = palmWidth / 2, ry = palmThickness / 2, gap = (70 * Math.PI / 180) / 2;
  const a0 = Math.PI / 2 + gap, a1 = Math.PI / 2 - gap + Math.PI * 2;
  const band = new THREE.Shape();
  band.absellipse(0, 0, rx + wall, ry + wall, a0, a1, false);
  band.absellipse(0, 0, rx, ry, a1, a0, true);
  band.closePath();
  const bandGeo = new THREE.ExtrudeGeometry(band, { depth: bandWidth, curveSegments: 96, bevelEnabled: false });
  bandGeo.translate(0, 0, -bandWidth / 2);

  // Pocket: a rectangular tube, its cross-section drawn in (z, y) and extruded along X.
  const t = 2.5, pw = slotWidth + 2 * t, ph = slotHeight + 2 * t, len = Math.min(palmWidth * 0.75, 60);
  const outer = new THREE.Shape();
  outer.moveTo(-pw / 2, -ph / 2); outer.lineTo(pw / 2, -ph / 2); outer.lineTo(pw / 2, ph / 2); outer.lineTo(-pw / 2, ph / 2); outer.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-slotWidth / 2, -slotHeight / 2); hole.lineTo(-slotWidth / 2, slotHeight / 2); hole.lineTo(slotWidth / 2, slotHeight / 2); hole.lineTo(slotWidth / 2, -slotHeight / 2); hole.closePath();
  outer.holes.push(hole);
  const pocketGeo = new THREE.ExtrudeGeometry(outer, { depth: len, bevelEnabled: false });
  pocketGeo.translate(0, 0, -len / 2);
  pocketGeo.rotateY(Math.PI / 2);
  // Overlap the band by 1 mm so the two print as one piece.
  pocketGeo.translate(0, -(ry + wall) - ph / 2 + 1, 0);

  return { bandGeo, pocketGeo, pocketLength: len };
}

/** Solid volume in cubic millimetres, from the signed tetrahedron sum. */
export function volume(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(v);
}
