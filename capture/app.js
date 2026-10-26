import { FilesetResolver, HandLandmarker, PoseLandmarker } from '/vendor/tasks-vision/vision_bundle.mjs';
import { REFERENCES, pxPerMmFrom, frameMetrics, summarize, buildProfile, recommend, scaleHandSummary } from './measure.js';
import { BODY_PARTS, POSE_POINTS, labelFor } from './bodyparts.js';
import { poseFrameMetrics, summarizePose, tapeMeasurements, buildBodyProfile, scalePoseSummary } from './measure-pose.js';

const $ = sel => document.querySelector(sel);
const video = $('#video');
const canvas = $('#overlay');
const ctx = canvas.getContext('2d');

const state = {
  part: 'hand',        // a key of BODY_PARTS
  fileset: null,
  landmarker: null,
  source: null,        // 'camera' | 'video'
  stream: null,
  objectUrl: null,
  pxPerMm: null,
  reference: null,
  calibrating: false,
  calPoints: [],
  recording: false,
  frames: [],
  lastResult: null,
  lastVideoTime: -1,
  lastTs: 0,
  profile: null,
  summary: null,       // the last recording, unscaled, so a length typed later can still rescale it
};

const def = () => BODY_PARTS[state.part];
const h = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = kind;
}

function markStep(id, stateName) {
  const el = $(`#step-${id}`);
  el.classList.remove('active', 'done');
  if (stateName) el.classList.add(stateName);
}

// ---------- model ----------
// The hand tracker for hands, the body tracker for everything else, nothing for tape-only parts.
async function loadModel() {
  state.landmarker?.close?.();
  state.landmarker = null;
  const d = def();
  if (d.tracker === 'none') return;
  state.fileset ||= await FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
  const pose = d.tracker === 'pose';
  const Tracker = pose ? PoseLandmarker : HandLandmarker;
  const options = delegate => ({
    baseOptions: { modelAssetPath: `/capture/models/${pose ? 'pose_landmarker_full' : 'hand_landmarker'}.task`, delegate },
    runningMode: 'VIDEO',
    ...(pose ? { numPoses: 1 } : { numHands: 1 }),
  });
  try {
    state.landmarker = await Tracker.createFromOptions(state.fileset, options('GPU'));
  } catch {
    // Some browsers and VMs have no usable WebGL; the CPU path is slower but works.
    state.landmarker = await Tracker.createFromOptions(state.fileset, options('CPU'));
  }
}

// ---------- sources ----------
function stopSource() {
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  video.removeAttribute('src');
  video.srcObject = null;
  video.controls = false;
}

async function useCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('This browser cannot open a camera here. Upload a video instead.', 'err');
    return;
  }
  stopSource();
  try {
    // Rear camera on a phone, so a parent can film someone else's hand; webcam elsewhere.
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    setStatus(`Camera unavailable: ${err.message}. Allow camera access, or upload a video.`, 'err');
    return;
  }
  state.source = 'camera';
  video.srcObject = state.stream;
  await video.play();
}

function useVideoFile(file) {
  if (!file) return;
  stopSource();
  state.source = 'video';
  state.objectUrl = URL.createObjectURL(file);
  video.src = state.objectUrl;
  video.controls = true;
}

video.addEventListener('loadedmetadata', () => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  $('#stage').style.setProperty('--ratio', String(video.videoWidth / video.videoHeight));
  $('#empty').hidden = true;
  $('#stage').hidden = false;
  $('#controls').hidden = false;
  state.lastVideoTime = -1;
  markStep('source', 'done');
  markStep('calibrate', knownMm() ? 'done' : 'active');
  setStatus(state.source === 'video' ? 'Video loaded. Press Record to analyse it.' : 'Camera on. Press Record when ready.', 'ok');
});

video.addEventListener('ended', () => { if (state.recording) stopRecording(); });

// ---------- tracking loop ----------
function tick() {
  requestAnimationFrame(tick);
  // Only run the model on frames we haven't seen; a paused video costs nothing.
  if (state.landmarker && video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    const ts = Math.max(performance.now(), state.lastTs + 1);   // the model needs rising timestamps
    state.lastTs = ts;
    try {
      onResult(state.landmarker.detectForVideo(video, ts));
    } catch (err) {
      console.error(err);
    }
  }
  draw();
}

function onResult(res) {
  state.lastResult = res;
  const lm = res.landmarks?.[0];
  if (!lm) {
    if (state.recording) state.frames.push(null);
    renderLive(null);
    return;
  }
  const input = {
    landmarks: lm,
    worldLandmarks: res.worldLandmarks[0],
    width: canvas.width,
    height: canvas.height,
    pxPerMm: state.pxPerMm,
  };
  // Null when a joint the body part needs is out of view; counted as a missed frame.
  const m = def().tracker === 'pose' ? poseFrameMetrics(def(), $('#side').value, input) : frameMetrics(input);
  if (state.recording) {
    state.frames.push(m);
    $('#recFrames').textContent = state.frames.filter(Boolean).length;
  }
  renderLive(m);
}

// ---------- drawing ----------
const TEAL = '#3fc2b0', AMBER = '#f0a646', WHITE = '#ffffff';

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const lw = Math.max(2, canvas.width / 420);
  const lm = state.lastResult?.landmarks?.[0];
  if (lm && def().tracker === 'pose') drawPose(lm, lw);
  else if (lm) {
    const pt = i => ({ x: lm[i].x * canvas.width, y: lm[i].y * canvas.height });
    ctx.lineWidth = lw;
    ctx.strokeStyle = TEAL;
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      const a = pt(start), b = pt(end);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // The opening being measured: thumb tip to index tip.
    const t = pt(4), i = pt(8);
    ctx.setLineDash([lw * 3, lw * 2]);
    ctx.strokeStyle = AMBER;
    ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(i.x, i.y); ctx.stroke();
    ctx.setLineDash([]);
    for (let k = 0; k < lm.length; k++) {
      const p = pt(k);
      ctx.beginPath(); ctx.arc(p.x, p.y, lw * 1.7, 0, Math.PI * 2);
      ctx.fillStyle = k === 4 || k === 8 ? AMBER : WHITE;
      ctx.fill();
      ctx.strokeStyle = TEAL; ctx.lineWidth = lw * 0.6; ctx.stroke();
      ctx.lineWidth = lw;
    }
  }
  // Calibration points and the line between them.
  if (state.calPoints.length) {
    ctx.fillStyle = AMBER; ctx.strokeStyle = AMBER; ctx.lineWidth = lw;
    for (const p of state.calPoints) { ctx.beginPath(); ctx.arc(p.x, p.y, lw * 2.4, 0, Math.PI * 2); ctx.fill(); }
    if (state.calPoints.length === 2) {
      const [a, b] = state.calPoints;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
}

/** Body tracker: only the joints this body part uses, and the segments between them. */
function drawPose(lm, lw) {
  const d = def(), idx = POSE_POINTS[$('#side').value] || POSE_POINTS.right;
  const pt = name => ({ x: lm[idx[name]].x * canvas.width, y: lm[idx[name]].y * canvas.height, v: lm[idx[name]].visibility ?? 1 });
  const segs = [...Object.values(d.lengths), ...Object.values(d.angles).flatMap(a => [[a.from, a.at], [a.at, a.to]])];
  ctx.lineWidth = lw * 1.4;
  ctx.strokeStyle = TEAL;
  for (const [a, b] of segs) {
    const p = pt(a), q = pt(b);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  const joints = new Set(Object.values(d.angles).map(a => a.at));
  for (const name of d.points) {
    const p = pt(name);
    ctx.beginPath(); ctx.arc(p.x, p.y, lw * 3, 0, Math.PI * 2);
    // Amber marks the joint being measured; grey means the tracker can't see the point.
    ctx.fillStyle = p.v < 0.5 ? '#8a9699' : joints.has(name) ? AMBER : WHITE;
    ctx.fill();
  }
}

// ---------- calibration ----------
function currentReference() {
  const key = $('#reference').value;
  if (key === 'custom') return { label: 'Custom reference', mm: Number($('#customMm').value) };
  return REFERENCES[key];
}

function startCalibration() {
  if (state.source === 'video') video.pause();
  state.calibrating = true;
  state.calPoints = [];
  canvas.classList.add('picking');
  setStatus(`Click one end of the ${currentReference().label.toLowerCase()}, then the other end.`, 'warn');
}

canvas.addEventListener('click', e => {
  if (!state.calibrating) return;
  const r = canvas.getBoundingClientRect();
  state.calPoints.push({
    x: (e.clientX - r.left) * canvas.width / r.width,
    y: (e.clientY - r.top) * canvas.height / r.height,
  });
  if (state.calPoints.length < 2) return;
  const ref = currentReference();
  try {
    state.pxPerMm = pxPerMmFrom(state.calPoints[0], state.calPoints[1], ref.mm);
    state.reference = ref;
  } catch (err) {
    setStatus(err.message, 'err');
    state.calPoints = [];
    return;
  }
  state.calibrating = false;
  canvas.classList.remove('picking');
  markStep('calibrate', 'done');
  markStep('record', 'active');
  setStatus(`Calibrated against the ${ref.label.toLowerCase()} (${ref.mm} mm). Now record.`, 'ok');
});

// ---------- recording ----------
function startRecording() {
  state.frames = [];
  state.recording = true;
  $('#record').textContent = 'Stop';
  $('#record').className = 'rec';
  $('#recdot').hidden = false;
  $('#recFrames').textContent = '0';
  $('#results').hidden = true;
  markStep('record', 'active');
  if (state.source === 'video') {
    // For a file, recording means analysing it from the start until it ends.
    video.currentTime = 0;
    video.play();
  }
  setStatus(`Recording. ${def().film}`, 'ok');
}

function stopRecording() {
  state.recording = false;
  $('#record').textContent = 'Record';
  $('#record').className = 'primary';
  $('#recdot').hidden = true;
  if (state.source === 'video') video.pause();

  const d = def();
  const summary = d.tracker === 'pose' ? summarizePose(d, state.frames) : summarize(state.frames);
  if (!summary) {
    setStatus(d.tracker === 'pose'
      ? `The tracker never saw the ${d.points.join(', ')} together. Film from the side with all of them in view and try again.`
      : 'No hand was found in that recording. Keep the whole hand in view and try again.', 'err');
    return;
  }
  state.summary = summary;
  buildFromSummary();
  const tracked = summary.trackedFrames ?? summary.handFrames;
  if (tracked < summary.frames * 0.5) setStatus(`Only ${tracked} of ${summary.frames} frames showed the whole ${d.label.toLowerCase()}. Results may be rough.`, 'warn');
  else setStatus(`Tracked ${tracked} of ${summary.frames} frames.${knownMm() ? '' : ' Sizes are estimates: type in the measured length to fix them.'}`, knownMm() ? 'ok' : 'warn');
  markStep('record', 'done');
}

// ---------- rendering ----------
const fmt = (v, unit) => (Number.isFinite(v) ? `${v.toFixed(unit === '°' ? 0 : 1)} ${unit}` : '–');

function renderLive(m) {
  const d = def();
  const rows = d.tracker === 'pose'
    ? [
      ['Body', m ? 'Found' : 'Not all joints in view'],
      ...Object.keys(d.angles).map(k => [labelFor(k), m ? fmt(m.angles[k], '°') : '–']),
      ...Object.keys(d.lengths).map(k => [labelFor(k), m ? fmt(m.lengths[k], 'mm') : '–']),
    ]
    : [
      ['Hand', m ? 'Found' : 'Not found'],
      ['Thumb-to-index opening', m ? fmt(m.aperture, 'mm') : '–'],
      ['Knuckle span', m ? fmt(m.knuckleSpan, 'mm') : '–'],
      ['Index curl', m ? fmt(m.curl.index, '°') : '–'],
    ];
  rows.push(['Scale', state.pxPerMm ? 'Calibrated' : 'Estimated']);
  $('#liveRows').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
}

function rows(entries) {
  return entries.map(([label, value]) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = label;
    const b = document.createElement('td'); b.textContent = value;
    tr.append(a, b);
    return tr;
  });
}

function renderResults(profile, rec) {
  $('#recCard').hidden = !rec;
  $('#recNotes').hidden = true;
  if (rec) renderRecommendation(rec);
  const unitOf = u => (u === 'deg' ? '°' : ` ${u}`);
  const src = v => (v.source === 'tape' ? ' (tape)' : '');
  $('#measureRows').replaceChildren(...rows(
    Object.entries(profile.measurements).map(([k, v]) => [`${v.label || labelFor(k)}${src(v)}`, `${v.value}${unitOf(v.unit)}`]),
  ));
  const motion = Object.entries(profile.motion);
  $('#motionRows').closest('div').hidden = !motion.length;
  $('#motionRows').replaceChildren(...rows(motion.map(([k, v]) => [labelFor(k), `${v.min}–${v.max}${unitOf(v.unit)}`])));
  $('#profileJson').textContent = JSON.stringify(profile, null, 2);
  $('#results').hidden = false;
  if (session) { $('#send').disabled = false; $('#send').textContent = 'Send to Fitted'; $('#sendMsg').textContent = ''; }
}

function renderRecommendation(rec) {
  $('#recLabel').textContent = rec.label;
  $('#recParam').textContent = rec.design === 'cuff'
    ? `Palm width: ${rec.params.palmWidth} mm`
    : `Grip diameter: ${rec.params.gripDiameter} mm`;
  $('#recReasons').replaceChildren(...rec.reasons.map(r => Object.assign(document.createElement('li'), { textContent: r })));
  $('#recNotes').replaceChildren(...rec.notes.map(n => Object.assign(document.createElement('li'), { textContent: n })));
  $('#recNotes').hidden = !rec.notes.length;
}

function downloadProfile() {
  if (!state.profile) return;
  const profile = finalProfile();
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${profile.bodyPart}-profile-${profile.capturedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- calibration by one measured length ----------

/** The length typed into step 2, in millimetres, or null. */
function knownMm() {
  const v = Number(String($('#knownLen').value).replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  return v * ($('#knownUnit').value === 'in' ? 25.4 : 10);
}

/** Turn the last recording into a profile, scaled by the measured length if there is one. */
function buildFromSummary() {
  if (!state.summary) return;
  const d = def(), side = $('#side').value, cal = d.calibrateWith, mm = knownMm();
  let summary = state.summary, reference = state.reference;
  if (cal && mm) {
    summary = d.tracker === 'pose' ? scalePoseSummary(summary, cal.key, mm) : scaleHandSummary(summary, cal.key, mm);
    reference = { label: `${cal.label}, measured`, mm: Math.round(mm * 10) / 10 };
  }
  if (d.tracker === 'pose') {
    state.profile = buildBodyProfile({ bodyPart: state.part, side, source: state.source, reference, summary });
    renderResults(finalProfile(), null);
  } else {
    state.profile = buildProfile(summary, { side, source: state.source, reference });
    renderResults(finalProfile(), recommend(state.profile));
  }
  if (mm) markStep('calibrate', 'done');
}

$('#knownLen').addEventListener('input', () => { if (state.summary) buildFromSummary(); });
$('#knownUnit').addEventListener('change', () => { if (state.summary) buildFromSummary(); });
$('#cardToggle').addEventListener('click', () => {
  $('#cardTools').hidden = !$('#cardTools').hidden;
  $('#cardToggle').textContent = $('#cardTools').hidden ? 'Use a card instead' : 'Hide card';
});

// ---------- Fitted session ----------
// A link from the Fitted dashboard carries ?t=<token>. The measurements (never
// the video) are sent back to that run, which starts the design pipeline.
const session = new URLSearchParams(location.search).get('t');

async function initSession() {
  if (!session) return;
  const el = $('#session');
  el.hidden = false;
  try {
    const res = await fetch(`/api/capture/${encodeURIComponent(session)}`);
    const info = await res.json();
    if (!res.ok) throw new Error(info.error);
    if (!info.accepting) throw new Error(`This link for ${info.person} has already been used. Ask for a new one to capture again.`);
    state.part = BODY_PARTS[info.bodyPart] ? info.bodyPart : 'hand';
    const what = BODY_PARTS[state.part].sided ? `the ${info.side} ${BODY_PARTS[state.part].label.toLowerCase()}` : BODY_PARTS[state.part].label.toLowerCase();
    el.textContent = `Capturing ${what} for ${info.person}. When the result appears, tap Send to Fitted.`;
    if (['left', 'right'].includes(info.side)) $('#side').value = info.side;
    // The run fixed the body part; the picker is only for standalone use.
    $('#partWrap').hidden = true;
    $('#sendWrap').hidden = false;
  } catch (err) {
    el.textContent = err.message || 'This capture link is not valid.';
    el.className = 'err';
  }
  if (!window.isSecureContext && def().tracker !== 'none') {
    // Browsers only allow live cameras on https or on the Mac itself.
    $('#useCamera').hidden = true;
    $('#pickVideoLabel').firstChild.textContent = 'Choose a video you recorded';
    el.textContent += ' Record a 10-second video with your camera app first, then choose it here.';
  }
}

async function sendProfile() {
  if (!state.profile || !session) return;
  const btn = $('#send'), msg = $('#sendMsg');
  btn.disabled = true;
  msg.textContent = 'Sending…';
  try {
    const res = await fetch(`/api/capture/${encodeURIComponent(session)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(finalProfile()),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    msg.textContent = out.message;
    btn.textContent = 'Sent';
  } catch (err) {
    msg.textContent = `Not sent: ${err.message}`;
    btn.disabled = false;
  }
}

// ---------- wiring ----------
function populateReferences() {
  const sel = $('#reference');
  for (const [key, ref] of Object.entries(REFERENCES)) sel.add(new Option(`${ref.label} (${ref.mm} mm)`, key));
  sel.add(new Option('Custom length…', 'custom'));
  sel.addEventListener('change', () => { $('#customWrap').hidden = sel.value !== 'custom'; });
}

$('#useCamera').addEventListener('click', useCamera);
$('#videoFile').addEventListener('change', e => useVideoFile(e.target.files[0]));
$('#calibrate').addEventListener('click', startCalibration);
$('#record').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
$('#download').addEventListener('click', downloadProfile);
$('#send').addEventListener('click', sendProfile);
$('#changeSource').addEventListener('click', () => {
  if (state.recording) stopRecording();
  stopSource();
  state.lastResult = null;
  state.calPoints = [];
  $('#stage').hidden = true;
  $('#controls').hidden = true;
  $('#empty').hidden = false;
  $('#videoFile').value = '';
  // A calibration only holds for one camera framing, so a new source needs a new one.
  state.pxPerMm = null;
  state.reference = null;
  renderLive(null);
  markStep('source', 'active');
  markStep('calibrate', null);
  markStep('record', null);
  setStatus('Choose a camera or a video.');
});

// ---------- body part and tape ----------

/** Set every instruction, field and tracker for the chosen body part. */
async function applyPart() {
  const d = def();
  const name = d.label.toLowerCase();
  const tapeOnly = d.tracker === 'none';
  $('#emptyTitle').textContent = tapeOnly ? 'Measure with a tape.' : `Film the ${name}. Get its measurements.`;
  $('#emptyText').textContent = tapeOnly
    ? 'A camera has nothing to track here. Fill in the measurements on the right, then save them.'
    : `Use a live camera, or upload a phone video. Type one length you measured with a ruler (step 2) and every size comes out in real millimetres.`;
  $('#videoChoices').hidden = tapeOnly;
  $('#filmText').textContent = d.film || '';
  if (d.calibrateWith) {
    $('#knownLabel').textContent = d.calibrateWith.label;
    $('#knownWhere').textContent = d.calibrateWith.where;
  }
  $('#knownLen').value = '';
  state.summary = null;
  $('.steps').closest('section').hidden = tapeOnly;
  $('#liveRows').closest('section').hidden = tapeOnly;
  $('#sideLabel').textContent = state.part === 'hand' ? 'Hand' : 'Side';
  $('#sideWrap').hidden = !d.sided;
  renderTapeFields();
  renderLive(null);

  $('#useCamera').disabled = true;
  $('#videoFile').disabled = true;
  if (tapeOnly) { setStatus('Fill in the measurements, then save.', 'ok'); return; }
  setStatus(`Loading the ${d.tracker === 'pose' ? 'body' : 'hand'} tracker…`);
  try {
    await loadModel();
    $('#useCamera').disabled = false;
    $('#videoFile').disabled = false;
    setStatus('Ready. Choose a camera or a video.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`Tracker failed to load: ${err.message}. Run npm run setup, then reload.`, 'err');
  }
}

function renderTapeFields() {
  const d = def();
  const fields = d.tape.map(t => {
    const label = document.createElement('label');
    label.className = 'tape-field';
    const input = Object.assign(document.createElement('input'), { type: 'text', inputMode: 'decimal', placeholder: t.optional ? 'optional' : '' });
    input.dataset.key = t.key;
    label.append(h('b', t.label), h('small', t.where), input);
    return label;
  });
  for (let i = 0; i < (d.customTape || 0); i++) {
    const row = document.createElement('div');
    row.className = 'tape-custom';
    const name = Object.assign(document.createElement('input'), { type: 'text', placeholder: i === 0 ? 'e.g. around the neck' : 'measurement name' });
    const value = Object.assign(document.createElement('input'), { type: 'text', inputMode: 'decimal', placeholder: 'value' });
    name.dataset.customName = i; value.dataset.customValue = i;
    row.append(name, value);
    fields.push(row);
  }
  $('#tapeFields').replaceChildren(...fields);
  $('#tapeSection').hidden = !fields.length;
  $('#describeWrap').hidden = !d.describe;
  $('#tapeOnly').hidden = d.tracker !== 'none';
}

const camel = s => s.trim().toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');

/** The tape fields as profile measurements, in millimetres. */
function currentTape() {
  const entries = [...document.querySelectorAll('#tapeFields [data-key]')].map(i => ({ key: i.dataset.key, value: i.value }));
  for (const nameInput of document.querySelectorAll('#tapeFields [data-custom-name]')) {
    const label = nameInput.value.trim();
    const value = document.querySelector(`#tapeFields [data-custom-value="${nameInput.dataset.customName}"]`).value;
    if (label) entries.push({ key: camel(label) || `measurement${nameInput.dataset.customName}`, value, label });
  }
  return tapeMeasurements(entries, $('#tapeUnit').value);
}

/** The profile as it stands, with the tape fields as they are now. Tape wins over camera. */
function finalProfile() {
  const p = structuredClone(state.profile);
  for (const [k, v] of Object.entries(p.measurements)) {
    if (v.source !== 'tape') continue;
    if (v.camera != null) p.measurements[k] = { value: v.camera, unit: 'mm', source: 'camera' };
    else delete p.measurements[k];
  }
  for (const [k, v] of Object.entries(currentTape())) {
    const cam = p.measurements[k];
    p.measurements[k] = cam ? { ...v, camera: cam.value } : v;
  }
  if (def().describe) p.description = $('#describe').value.trim();
  return p;
}

function saveTapeOnly() {
  const tape = currentTape();
  const description = $('#describe').value.trim();
  if (def().describe && !description) return setStatus('Say what the device is for first.', 'err');
  if (!Object.keys(tape).length) return setStatus('Enter at least one measurement.', 'err');
  state.profile = buildBodyProfile({ bodyPart: state.part, side: def().sided ? $('#side').value : 'none', tape, description });
  renderResults(finalProfile(), null);
  setStatus('Measurements saved.', 'ok');
}

// Re-show results when a tape value changes after recording, so what is sent matches the screen.
$('#tapeSection').addEventListener('input', () => { if (state.profile && def().tracker !== 'none') renderResults(finalProfile(), $('#recCard').hidden ? null : recommend(state.profile)); });
$('#tapeOnly').addEventListener('click', saveTapeOnly);

function populateParts() {
  const sel = $('#partPick');
  for (const [key, p] of Object.entries(BODY_PARTS)) sel.add(new Option(p.label, key));
  sel.addEventListener('change', () => {
    state.part = sel.value;
    $('#changeSource').click();
    state.profile = null;
    $('#results').hidden = true;
    applyPart();
  });
}

populateReferences();
populateParts();
requestAnimationFrame(tick);
initSession().then(applyPart);
