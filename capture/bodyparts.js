// Every body part Fitted can capture, in one place. The capture page, the
// design pipeline, its checks and its Obsidian notes all read this file, so
// adding a body part means adding an entry here.
//
// Each part says:
// - tracker: 'hand' (MediaPipe hand, 21 points), 'pose' (MediaPipe body, 33
//   points), or 'none' (tape measurements only)
// - for 'pose': which body points it uses, which lengths to measure between
//   them, and which joint angles to track across the recording
// - tape: what to measure by hand, because a camera can't see around a limb
// - ranges: plausible values, used only to flag likely mistakes

/** MediaPipe Pose landmark indices, by the subject's own left and right. */
export const POSE_POINTS = {
  left: { shoulder: 11, elbow: 13, wrist: 15, pinky: 17, index: 19, thumb: 21, hip: 23, knee: 25, ankle: 27, heel: 29, foot: 31 },
  right: { shoulder: 12, elbow: 14, wrist: 16, pinky: 18, index: 20, thumb: 22, hip: 24, knee: 26, ankle: 28, heel: 30, foot: 32 },
};

export const BODY_PARTS = {
  hand: {
    label: 'Hand',
    tracker: 'hand',
    sided: true,
    film: 'Palm facing the camera. Hand relaxed, then open as wide as it goes, then close or try to grip.',
    calibrate: 'Hold a bank card flat beside the hand, the same distance from the camera.',
    calibrateWith: { key: 'handLength', label: 'Hand length', where: 'Hand flat. From the crease where the wrist meets the palm to the tip of the middle finger.' },
    tape: [
      { key: 'wristCircumference', label: 'Around the wrist', where: 'Just above the wrist bone, snug but not tight.', range: [100, 220], optional: true },
    ],
    ranges: { knuckleSpan: [35, 110], palmLength: [50, 130] },
  },

  wrist: {
    label: 'Wrist & forearm',
    tracker: 'pose',
    sided: true,
    points: ['elbow', 'wrist', 'index'],
    lengths: { forearmLength: ['elbow', 'wrist'] },
    angles: { wristBend: { at: 'wrist', from: 'elbow', to: 'index', kind: 'bend', label: 'Wrist bend (up or down)' } },
    film: 'Film from the side with the whole forearm and hand in view. Bend the wrist down as far as it goes, then up as far as it goes, slowly.',
    calibrate: 'Hold a bank card flat beside the forearm, the same distance from the camera.',
    calibrateWith: { key: 'forearmLength', label: 'Forearm length', where: 'From the point of the elbow to the crease of the wrist, on the little-finger side.' },
    tape: [
      { key: 'wristCircumference', label: 'Around the wrist', where: 'Just above the wrist bone.', range: [100, 220] },
      { key: 'forearmCircumference', label: 'Around the forearm', where: 'At the widest point, a hand-width below the elbow.', range: [140, 380] },
      { key: 'handBreadth', label: 'Across the hand', where: 'Straight across the knuckles, thumb not included.', range: [50, 110] },
    ],
    ranges: { forearmLength: [150, 330] },
  },

  elbow: {
    label: 'Elbow',
    tracker: 'pose',
    sided: true,
    points: ['shoulder', 'elbow', 'wrist'],
    lengths: { upperArmLength: ['shoulder', 'elbow'], forearmLength: ['elbow', 'wrist'] },
    angles: { elbowBend: { at: 'elbow', from: 'shoulder', to: 'wrist', kind: 'bend', label: 'Elbow bend' } },
    film: 'Film from the side with shoulder, elbow and wrist in view. Straighten the arm as far as it goes, then bend it as far as it goes, slowly.',
    calibrate: 'Hold a bank card flat against the upper arm, facing the camera.',
    calibrateWith: { key: 'forearmLength', label: 'Forearm length', where: 'From the point of the elbow to the crease of the wrist, on the little-finger side.' },
    tape: [
      { key: 'upperArmCircumference', label: 'Around the upper arm', where: 'Halfway between shoulder and elbow.', range: [160, 480] },
      { key: 'elbowCircumference', label: 'Around the elbow', where: 'Over the point of the elbow, arm slightly bent.', range: [180, 400] },
      { key: 'forearmCircumference', label: 'Around the forearm', where: 'At the widest point, a hand-width below the elbow.', range: [140, 380] },
    ],
    ranges: { upperArmLength: [180, 400], forearmLength: [150, 330] },
  },

  knee: {
    label: 'Knee',
    tracker: 'pose',
    sided: true,
    points: ['hip', 'knee', 'ankle'],
    lengths: { thighLength: ['hip', 'knee'], shinLength: ['knee', 'ankle'] },
    angles: { kneeBend: { at: 'knee', from: 'hip', to: 'ankle', kind: 'bend', label: 'Knee bend' } },
    film: 'Film from the side with hip, knee and ankle in view, seated or lying down. Straighten the knee as far as it goes, then bend it as far as it goes, slowly.',
    calibrate: 'Hold a bank card flat against the side of the shin, facing the camera.',
    calibrateWith: { key: 'shinLength', label: 'Shin length', where: 'From the bony bump on the outside of the knee to the ankle bone on the same side.' },
    tape: [
      { key: 'thighCircumference', label: 'Around the thigh', where: 'A hand-width (about 10 cm) above the top of the kneecap.', range: [250, 800] },
      { key: 'kneeCircumference', label: 'Around the knee', where: 'Across the middle of the kneecap, leg straight.', range: [220, 600] },
      { key: 'calfCircumference', label: 'Around the calf', where: 'At the widest point of the calf.', range: [180, 550] },
    ],
    ranges: { thighLength: [250, 560], shinLength: [220, 520] },
  },

  ankle: {
    label: 'Ankle & foot',
    tracker: 'pose',
    sided: true,
    points: ['knee', 'ankle', 'heel', 'foot'],
    lengths: { shinLength: ['knee', 'ankle'], footLength: ['heel', 'foot'] },
    angles: { ankleAngle: { at: 'ankle', from: 'knee', to: 'foot', kind: 'angle', label: 'Shin-to-foot angle (90° = foot at right angle)' } },
    film: 'Film from the side with knee, ankle and whole foot in view. Point the toes down as far as they go, then pull them up as far as they go, slowly.',
    calibrate: 'Lay a bank card flat on the floor beside the foot, or hold it against the shin.',
    calibrateWith: { key: 'shinLength', label: 'Shin length', where: 'From the bony bump on the outside of the knee to the ankle bone on the same side.' },
    tape: [
      { key: 'calfCircumference', label: 'Around the calf', where: 'At the widest point of the calf.', range: [180, 550] },
      { key: 'ankleCircumference', label: 'Around the ankle', where: 'Just above the ankle bones.', range: [150, 350] },
      { key: 'footLength', label: 'Foot length', where: 'Heel to the tip of the longest toe, standing if possible.', range: [100, 330] },
      { key: 'footWidth', label: 'Foot width', where: 'Across the widest part of the foot.', range: [50, 130] },
    ],
    ranges: { shinLength: [220, 520], footLength: [100, 330] },
  },

  other: {
    label: 'Other',
    tracker: 'none',
    sided: false,
    describe: true,
    film: null,
    tape: [],
    // Free-form: the person names up to six measurements themselves.
    customTape: 6,
    ranges: {},
  },
};

export const bodyPart = id => BODY_PARTS[id] || null;

/** Label for any measurement or motion key, across all body parts. */
export function labelFor(key) {
  for (const p of Object.values(BODY_PARTS)) {
    const t = p.tape.find(t => t.key === key);
    if (t) return t.label;
    if (p.angles?.[key]) return p.angles[key].label;
  }
  return HAND_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
}

const HAND_LABELS = {
  knuckleSpan: 'Knuckle span', palmLength: 'Palm length', handLength: 'Hand length',
  thumbLength: 'Thumb', indexLength: 'Index finger', middleLength: 'Middle finger',
  ringLength: 'Ring finger', pinkyLength: 'Little finger',
  aperture: 'Thumb-to-index opening', thumbCurl: 'Thumb curl', indexCurl: 'Index curl',
  middleCurl: 'Middle curl', ringCurl: 'Ring curl', pinkyCurl: 'Little finger curl',
  upperArmLength: 'Upper arm', forearmLength: 'Forearm', thighLength: 'Thigh', shinLength: 'Shin', footLength: 'Foot length',
};
