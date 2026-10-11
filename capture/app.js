import { FilesetResolver, HandLandmarker } from '/vendor/tasks-vision/vision_bundle.mjs';
import { REFERENCES, pxPerMmFrom, frameMetrics, summarize, buildProfile, recommend } from './measure.js';

const $ = sel => document.querySelector(sel);
const video = $('#video');
const canvas = $('#overlay');
const ctx = canvas.getContext('2d');

const state = {
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
};

const LABELS = {
  knuckleSpan: 'Knuckle span', palmLength: 'Palm length', handLength: 'Hand length',
  thumbLength: 'Thumb', indexLength: 'Index finger', middleLength: 'Middle finger',
  ringLength: 'Ring finger', pinkyLength: 'Little finger',
  aperture: 'Thumb-to-index opening', thumbCurl: 'Thumb curl', indexCurl: 'Index curl',
  middleCurl: 'Middle curl', ringCurl: 'Ring curl', pinkyCurl: 'Little finger curl',
};

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
async function loadModel() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
  const options = delegate => ({
    baseOptions: { modelAssetPath: '/capture/models/hand_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numHands: 1,
  });
  try {
    state.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    // Some browsers and VMs have no usable WebGL; the CPU path is slower but works.
    state.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
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
  markStep('calibrate', 'active');
  setStatus(state.source === 'video'
    ? 'Video loaded. Pause on a frame where the card is visible, then calibrate.'
    : 'Camera on. Hold a bank card beside the hand, then calibrate.', 'ok');
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
  const m = frameMetrics({
    landmarks: lm,
    worldLandmarks: res.worldLandmarks[0],
    width: canvas.width,
    height: canvas.height,
    pxPerMm: state.pxPerMm,
  });
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
  if (lm) {
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
  setStatus(state.pxPerMm
    ? 'Recording. Relax the hand, open it wide, then close it.'
    : 'Recording without calibration: sizes will be estimates.', state.pxPerMm ? 'ok' : 'warn');
}

function stopRecording() {
  state.recording = false;
  $('#record').textContent = 'Record';
  $('#record').className = 'primary';
  $('#recdot').hidden = true;
  if (state.source === 'video') video.pause();

  const summary = summarize(state.frames);
  if (!summary) {
    setStatus('No hand was found in that recording. Keep the whole hand in view and try again.', 'err');
    return;
  }
  state.profile = buildProfile(summary, { side: $('#side').value, source: state.source, reference: state.reference });
  renderResults(state.profile, recommend(state.profile));
  markStep('record', 'done');
  setStatus(`Captured ${summary.handFrames} of ${summary.frames} frames with a hand.`, 'ok');
}

// ---------- rendering ----------
const fmt = (v, unit) => (Number.isFinite(v) ? `${v.toFixed(unit === '°' ? 0 : 1)} ${unit}` : '–');

function renderLive(m) {
  $('#liveHand').textContent = m ? 'Found' : 'Not found';
  $('#liveOpen').textContent = m ? fmt(m.aperture, 'mm') : '–';
  $('#liveSpan').textContent = m ? fmt(m.knuckleSpan, 'mm') : '–';
  $('#liveCurl').textContent = m ? fmt(m.curl.index, '°') : '–';
  $('#liveScale').textContent = state.pxPerMm ? 'Calibrated' : 'Estimated';
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
  $('#recLabel').textContent = rec.label;
  $('#recParam').textContent = rec.design === 'cuff'
    ? `Palm width: ${rec.params.palmWidth} mm`
    : `Grip diameter: ${rec.params.gripDiameter} mm`;
  $('#recReasons').replaceChildren(...rec.reasons.map(r => Object.assign(document.createElement('li'), { textContent: r })));
  $('#recNotes').replaceChildren(...rec.notes.map(n => Object.assign(document.createElement('li'), { textContent: n })));
  $('#recNotes').hidden = !rec.notes.length;

  const unitOf = u => (u === 'deg' ? '°' : u);
  $('#measureRows').replaceChildren(...rows(
    Object.entries(profile.measurements).map(([k, v]) => [LABELS[k] ?? k, `${v.value} ${unitOf(v.unit)}`]),
  ));
  $('#motionRows').replaceChildren(...rows(
    Object.entries(profile.motion).map(([k, v]) => [LABELS[k] ?? k, `${v.min}–${v.max} ${unitOf(v.unit)}`]),
  ));
  $('#profileJson').textContent = JSON.stringify(profile, null, 2);
  $('#results').hidden = false;
}

function downloadProfile() {
  if (!state.profile) return;
  const blob = new Blob([JSON.stringify(state.profile, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hand-profile-${state.profile.capturedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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

populateReferences();
requestAnimationFrame(tick);
loadModel().then(() => {
  $('#useCamera').disabled = false;
  $('#videoFile').disabled = false;
  setStatus('Ready. Choose a camera or a video.', 'ok');
}, err => {
  console.error(err);
  setStatus(`Hand model failed to load: ${err.message}. Run npm install, then reload.`, 'err');
});
