# Fitted

Assistive devices fitted to one person's body. This repo starts with the first
step: measuring a hand from video.

## Hand capture

    npm install
    npm run setup      # downloads the hand model (7.8 MB)
    npm start          # → http://localhost:7780/capture/

Use a live camera or upload a phone video.

1. **Calibrate.** Hold a bank card flat beside the hand, the same distance from
   the camera. Click Calibrate, then click both ends of the card's long edge.
   Without this, sizes are estimates based on an average adult hand.
2. **Record about 10 seconds.** Palm facing the camera: relaxed, open as wide
   as it goes, then close or try to grip.
3. **Read the result.** Sizes, range of motion, a suggested starting design,
   and a downloadable body profile.

Everything runs in the browser. Video never leaves the machine.

## How measuring works

MediaPipe gives 21 hand points in two forms: where they are in the image, and
a 3D shape scaled to an average adult. Lengths come from the 3D shape, so a
finger curling toward the camera doesn't look shorter. One calibration, the
knuckle span measured against the card, converts that shape to real
millimetres for this hand, including children's hands.

Finger curl is the sum of the bends at the three joints. The knuckle bend is
measured against the plane of the palm, so fingers spreading apart isn't
counted as curling.

## The body profile

Every body part writes the same shape, so design code never needs to know
which tracker produced a profile:

```json
{
  "schema": "fitted.body-profile/v1",
  "bodyPart": "hand",
  "measurements": { "knuckleSpan": { "value": 68.2, "unit": "mm" } },
  "motion":       { "aperture": { "min": 12.0, "max": 94.5, "unit": "mm" } },
  "scale":        { "method": "reference", "spreadPct": 0.5 }
}
```

Adding a body part means a new tracker that fills `measurements` and `motion`
with its own names. Nothing downstream changes.

## Files

| File | What it does |
|---|---|
| `capture/measure.js` | All measurement maths, with no browser dependencies |
| `capture/measure.test.js` | `npm test`, using a synthetic hand with known geometry |
| `capture/app.js` | Camera, tracking loop, calibration, recording, results |
| `capture/index.html` | The capture page |
| `server.js` | Local server for the page, MediaPipe, and the model. No CDN. |
| `capture/testdata/` | MediaPipe's public test photos, for checks without a camera |

## Known limits

- **Not yet tested on a real camera, or on the hands this is for.** MediaPipe
  learned mostly from typical hands. Tight, clenched, or thumb-in-palm hands
  may track poorly. Testing on those is the next job and the biggest risk.
- **The design suggestion uses placeholder rules.** The thresholds in
  `recommend()` exist to exercise the pipeline. They are not clinical guidance
  and must be replaced with sizing rules from occupational therapists.
- **Fingertip joints are noisy.** A straight finger reads about 40° of curl,
  most of it at the fingertip joint, where the model's depth estimate is
  weakest from the front. Read curl as a range across the recording, not a
  single value.
- **Calibration assumes the card and palm share a plane facing the camera.**
  The frame-to-frame spread is shown so a bad calibration is visible.
- One hand at a time, and you pick left or right yourself.
- Wrist angle isn't measured. It needs a body tracker, which matters for the
  palm bulb's neck angle.
