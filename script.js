
/* ============================================================================
   SafeScan – Camera + Barcode Decoding + Ingredients + Level 2/3 Warnings
   Paste over your current script.js (no other file changes required).

   Notes:
   - Camera requires HTTPS or localhost to access (secure context). [MDN] 
   - iOS Safari often needs <video playsinline autoplay muted> + video.play(). [MDN]
   - ZXing-JS must be loaded via CDN before this script. [ZXing docs]

   References:
   - Secure contexts & getUserMedia requirement: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia   (secure contexts) ¹
   - iOS/Safari video playback details & examples: https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos ²
   - ZXing-JS browser usage (UMD, BrowserMultiFormatReader): https://github.com/zxing-js/browser ³
   ============================================================================ */

/* ---------- DOM ---------- */
const els = {
  video:   document.getElementById('preview'),
  status:  document.getElementById('camera-status'),
  start:   document.getElementById('start'),
  flip:    document.getElementById('flip'),
  capture: document.getElementById('capture'),
  stop:    document.getElementById('stop'),
  canvas:  document.getElementById('snapshot'),
  // Results panel (optional but recommended)
  resName: document.getElementById('res-name'),
  resBrand: document.getElementById('res-brand'),
  resBarcode: document.getElementById('res-barcode'),
  resIngredients: document.getElementById('res-ingredients'),
  resLvl2: document.getElementById('res-lvl2'),
  resLvl3: document.getElementById('res-lvl3'),
  resOK: document.getElementById('res-ok'),
};

/* ---------- State ---------- */
let currentStream = null;
let usingDeviceId = null;
let facing = 'environment';
let codeReader = null;          // ZXing reader
let zxingActive = false;
let avoidList = [];             // normalized avoid list
let lastCode = null;            // debounce
let lastAt = 0;

/* ---------- Helpers ---------- */
const isSecure =
  location.protocol === 'https:' ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1';

function setStatus(msg, isError = false) {
  console.log('[SafeScan]', msg);
  if (els.status) {
    els.status.textContent = msg;
    els.status.style.color = isError ? '#c62828' : '#8be28b';
  }
}

function enableControls(started) {
  if (!els.start) return;
  els.start.disabled   = started;
  if (els.flip)    els.flip.disabled    = !started;
  if (els.capture) els.capture.disabled = !started;
  if (els.stop)    els.stop.disabled    = !started;
}

/* ---------- iOS-friendly video ---------- */
if (els.video) {
  els.video.setAttribute('playsinline', 'true');
  els.video.setAttribute('autoplay', 'true');
  els.video.muted = true;
}

/* ---------- Avoid list ---------- */
function normalizeAvoid(raw) {
  const name = String(raw.name || raw.term || '').trim().toLowerCase();
  const level = Number(raw.level ?? raw.severity ?? 0);
  const synonyms = Array.isArray(raw.synonyms) ? raw.synonyms : [];
  const terms = [name, ...synonyms].filter(Boolean).map(t => t.toLowerCase());
  return { name, level, terms };
}

async function loadAvoidList() {
  try {
    const res = await fetch('avoid_list.json', { cache: 'no-store' });
    const data = await res.json();
    avoidList = Array.isArray(data) ? data.map(normalizeAvoid) : [];
    setStatus(`Avoid list loaded (${avoidList.length} items).`);
  } catch (e) {
    setStatus('Could not load avoid_list.json. Warnings will be unavailable.', true);
    avoidList = [];
  }
}

/* ---------- Camera ---------- */
async function getVideoInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

async function openStream(preferBack = true, deviceId = null) {
  const constraints = deviceId
    ? { video: { deviceId: { exact: deviceId } }, audio: false }
    : {
        video: preferBack
          ? { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : true,
        audio: false
      };

  setStatus('Requesting camera…');

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    ensureTracks(stream);
    await attachStream(stream);
    return stream;
  } catch (err) {
    // Fallback: any camera
    setStatus(`Retrying camera (fallback): ${err?.name || err}`, true);
    try {
      const fallback = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      ensureTracks(fallback);
      await attachStream(fallback);
      return fallback;
    } catch (err2) {
      setStatus(`Camera failed: ${err2?.name || err2}`, true);
      return null;
    }
  }
}

function ensureTracks(stream) {
  const tracks = stream.getVideoTracks();
  if (!tracks || !tracks.length) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('No video tracks returned.');
  }
}

async function attachStream(stream) {
  // Stop previous stream
  if (currentStream) currentStream.getTracks().forEach(t => t.stop());
  currentStream = stream;

  const track = stream.getVideoTracks()[0];
  const info  = track.getSettings?.() || {};
  usingDeviceId = info.deviceId || null;

  els.video.srcObject = stream;
  try { await els.video.play(); } catch { /* iOS may need user gesture */ }
  enableControls(true);

  await startDecoding();
}

function stopStream() {
  stopDecoding();
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  usingDeviceId = null;
  setStatus('Camera stopped.');
  enableControls(false);
  if (els.video) els.video.srcObject = null;
}

async function flipCamera() {
  const inputs = await getVideoInputs();
  if (inputs.length < 2) {
    facing = (facing === 'environment') ? 'user' : 'environment';
    await startCamera();
    return;
  }
  const alt = inputs.find(d => d.deviceId !== usingDeviceId) || inputs[0];
  facing = (facing === 'environment') ? 'user' : 'environment';
  await startCamera(alt.deviceId);
}

function captureFrame() {
  if (!currentStream || !els.canvas) return;
  const { videoWidth: w, videoHeight: h } = els.video;
  if (!w || !h) return;
  els.canvas.width = w; els.canvas.height = h;
  const ctx = els.canvas.getContext('2d');
  ctx.drawImage(els.video, 0, 0, w, h);
  setStatus('Frame captured.');
}

async function startCamera(forceDeviceId = null) {
  if (!isSecure) {
    setStatus('Camera requires HTTPS or localhost.', true);
    alert('Open over HTTPS (GitHub Pages) or run on localhost.');
    return;
  }
  if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
    setStatus('getUserMedia() not supported in this browser.', true);
    alert('Update to a modern browser.');
    return;
  }

  await loadAvoidList();
  await openStream(true, forceDeviceId);
}

/* ---------- ZXing (barcode decoding) ---------- */
function make1DHints() {
  if (!window.ZXing) return null;
  const ZX = window.ZXing;
  const hints = new ZX.Map();
  const formats = [
    ZX.BarcodeFormat.EAN_13,
    ZX.BarcodeFormat.EAN_8,
    ZX.BarcodeFormat.UPC_A,
    ZX.BarcodeFormat.UPC_E,
    ZX.BarcodeFormat.CODE_128
  ];
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, formats);
  return hints;
}

async function startDecoding() {
  if (!window.ZXing || !window.ZXing.BrowserMultiFormatReader) {
    setStatus('ZXing not loaded. Ensure the CDN script is before script.js', true);
    return;
  }

  stopDecoding(); // clear previous
  const hints = make1DHints();
  codeReader = hints
    ? new window.ZXing.BrowserMultiFormatReader(hints, 250)
    : new window.ZXing.BrowserMultiFormatReader(undefined, 250);
  zxingActive = true;

  // Use current deviceId if present; null lets ZXing choose
  let deviceId = null;
  try {
    const s = els.video.srcObject;
    if (s && s.getVideoTracks()[0]?.getSettings) {
      deviceId = s.getVideoTracks()[0].getSettings().deviceId || null;
    }
  } catch {}

  await codeReader.decodeFromVideoDevice(deviceId, els.video, (result, err) => {
    if (!zxingActive) return;

    if (result) {
      const text = result.getText ? result.getText() : String(result.text || '');
      const now = Date.now();
      // Debounce: same code within 2s ignored
      if (text && (text !== lastCode || (now - lastAt) > 2000)) {
        lastCode = text; lastAt = now;
        setStatus(`Scanned: ${text}`);
        onBarcode(text, result);
      }
    } else if (err && !(err instanceof window.ZXing.NotFoundException)) {
      console.warn('[ZXing error]', err);
    }
  });

  setStatus('Scanning… point camera at the barcode.');
}

function stopDecoding() {
  if (codeReader) {
    try { codeReader.reset(); } catch {}
  }
  codeReader = null;
  zxingActive = false;
}

/* ---------- Barcode handler: lookup + warnings ---------- */
function onBarcode(barcode /*, result */) {
  // If you already had a handler, keep calling it here:
  // e.g., fetchAndDisplayProduct(barcode). For convenience we implement it below.
  fetchAndDisplayProduct(barcode);
}

/* ---------- OFF lookup + ingredients ---------- */
function uniq(list) {
  const seen = new Set(); const out = [];
  for (const item of list) { if (!seen.has(item)) { seen.add(item); out.push(item); } }
  return out;
}

function normalizeIngredient(s) {
  if (!s) return '';
  // lower-case, trim, remove (...) notes, collapse separators, strip non-alnum edges
  let t = s.toLowerCase().trim();
  t = t.replace(/\([^)]*\)/g, '');           // remove parentheses content
  t = t.replace(/[\s\-_/]+/g, ' ').trim();   // collapse separators
  t = t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''); // strip non-alnum at ends
  return t;
}

function buildIngredientsList(text, arr) {
  if (arr && arr.length) {
    return uniq(arr.map(x => normalizeIngredient(x?.text || '')).filter(Boolean));
  }
  if (!text) return [];
  return uniq(text.split(/[,;]+/).map(normalizeIngredient).filter(Boolean));
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findTermHit(ingredients, terms) {
  for (const t of terms) {
    const needle = t.toLowerCase();
    for (const ing of ingredients) {
      if (ing === needle || new RegExp(`\\b${escapeRegex(needle)}\\b`).test(ing)) {
        return needle;
      }
    }
  }
  return null;
}

function matchIngredients(ingredients, avoid) {
  const lvl2 = [], lvl3 = [];
  for (const entry of avoid) {
    if (!entry || !entry.terms || !entry.level) continue;
    const hit = findTermHit(ingredients, entry.terms);
    if (hit) (entry.level === 3 ? lvl3 : lvl2).push({ term: hit, name: entry.name });
  }
  return { lvl2, lvl3 };
}

function renderWarnings(productName, matches) {
  const { lvl2, lvl3 } = matches;
  function setList(ul, items, noneText) {
    if (!ul) return;
    ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = `<li>${noneText}</li>`; return; }
    items.forEach(m => {
      const li = document.createElement('li');
      li.textContent = `${productName} (${m.term})`;
      ul.appendChild(li);
    });
  }
  setList(els.resLvl3, lvl3, 'None');
  setList(els.resLvl2, lvl2, 'None');
  if (els.resOK) {
    els.resOK.innerHTML = (!lvl2.length && !lvl3.length)
      ? '<li>No Level 2 or Level 3 ingredients detected</li>'
      : '<li>—</li>';
  }
}

async function fetchAndDisplayProduct(barcode) {
  setStatus(`Looking up ${barcode}…`);
  const base = 'https://world.openfoodfacts.org/api/v2/product/';
  const fields = 'product_name,brands,ingredients_text,ingredients';
  const url = `${base}${encodeURIComponent(barcode)}?fields=${encodeURIComponent(fields)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const p = data?.product || {};

    const name   = p.product_name || 'Unknown';
    const brand  = p.brands || '';
    const ingTxt = (p.ingredients_text || '').trim();
    const ingArr = Array.isArray(p.ingredients) ? p.ingredients : [];

    // Normalize ingredients
    const ingredientsList = buildIngredientsList(ingTxt, ingArr);

    // Update UI (if elements exist)
    if (els.resName)  els.resName.textContent  = name || '—';
    if (els.resBrand) els.resBrand.textContent = brand || '—';
    if (els.resBarcode) els.resBarcode.textContent = barcode || '—';
    if (els.resIngredients) els.resIngredients.textContent = (ingredientsList.join(', ') || '—');

    // Match against avoid list and render warnings
    const matches = matchIngredients(ingredientsList, avoidList);
    renderWarnings(name, matches);

    setStatus('Ingredients loaded. Matches evaluated.');
  } catch (e) {
    setStatus('Lookup failed. Try again.', true);
    console.error('OFF fetch error:', e);
  }
}

/* ---------- Wire UI ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  try { await startCamera(); } catch {}
});
if (els.start) els.start.addEventListener('click', () => startCamera());
if (els.flip)  els.flip.addEventListener('click', () => flipCamera());
if (els.capture) els.capture.addEventListener('click', () => captureFrame());
if (els.stop) els.stop.addEventListener('click', () => stopStream());
