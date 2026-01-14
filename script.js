
/* ============================================================================
   SafeScan – Camera + Barcode + Ingredients + Level 2/3 Warnings (fixed)
   - Fix: syntax error in `els`
   - Fix: use ZXingBrowser (UMD) instead of ZXing
   - Hardened Start button wiring; iOS-safe start
   ============================================================================ */

/* ---------- DOM ---------- */
const byId = (id) => document.getElementById(id);
const pick = (...ids) => ids.map(byId).find(Boolean) || null;

const els = {
  video: byId('preview'),
  status: byId('camera-status'),
  start: pick('start', 'start-button'),   // supports either id
  flip: byId('flip'),
  capture: byId('capture'),
  stop: byId('stop'),
  canvas: byId('snapshot'),

  // Results (optional)
  resName: byId('res-name'),
  resBrand: byId('res-brand'),
  resBarcode: byId('res-barcode'),
  resIngredients: byId('res-ingredients'),
  resLvl2: byId('res-lvl2'),
  resLvl3: byId('res-lvl3'),
  resOK: byId('res-ok'),
};

/* ---------- State ---------- */
let currentStream = null;
let currentControls = null; // ZXing controls handle
let usingDeviceId = null;
let facing = 'environment';
let reader = null; // ZXing reader
let zxingActive = false;

let avoidList = []; // normalized avoid list
let lastCode = null;
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
    els.status.style.color = isError ? '#c62828' : 'inherit';
  }
}

function enableControls(started) {
  const set = (el, disabled) => { if (el) el.disabled = disabled; };
  set(els.start, started);
  set(els.flip, !started);
  set(els.capture, !started);
  set(els.stop, !started);
}

/* iOS-friendly video configuration */
if (els.video) {
  els.video.setAttribute('playsinline', 'true');
  els.video.setAttribute('autoplay', 'true');
  els.video.muted = true;
}

/* ---------- Avoid list ---------- */
function normalizeAvoid(raw) {
  const name = String(raw?.name ?? raw?.term ?? '').trim().toLowerCase();
  const level = Number(raw?.level ?? raw?.severity ?? 0);
  const synonyms = Array.isArray(raw?.synonyms) ? raw.synonyms : [];
  const terms = [name, ...synonyms].filter(Boolean).map(t => t.toLowerCase());
  return { name, level, terms };
}

async function loadAvoidList() {
  try {
    const res = await fetch('avoid_list.json', { cache: 'no-store' });
    const data = await res.json();
    avoidList = Array.isArray(data) ? data.map(normalizeAvoid) : [];
    setStatus(`Avoid list loaded (${avoidList.length} items).`);
  } catch {
    setStatus('avoid_list.json not found (warnings will still show “None”).', true);
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
          ? {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
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

  try {
    const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
    usingDeviceId = settings.deviceId || null;
  } catch { usingDeviceId = null; }

  els.video.srcObject = stream;
  try { await els.video.play(); } catch { /* iOS needs a user gesture */ }

  enableControls(true);
  await startDecoding(); // start ZXing on this stream
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
    alert('Open over HTTPS (e.g., GitHub Pages) or run on localhost.');
    return;
  }
  if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
    setStatus('getUserMedia() not supported in this browser.', true);
    alert('Update to a modern browser.');
    return;
  }
  await loadAvoidList();       // doesn’t block camera if missing
  await openStream(true, forceDeviceId);
}

/* ---------- ZXing (barcode decoding) ---------- */
async function startDecoding() {
  // Ensure ZXingBrowser (UMD) is available
  if (!window.ZXingBrowser || !ZXingBrowser.BrowserMultiFormatReader) {
    setStatus('ZXing not loaded. Ensure the CDN script is before script.js', true);
    return;
  }

  stopDecoding(); // clear previous reader/controls

  reader = new ZXingBrowser.BrowserMultiFormatReader(); // default hints cover major formats
  zxingActive = true;

  // Prefer the current deviceId if we have it; otherwise let ZXing choose.
  let deviceId = null;
  try {
    const s = els.video.srcObject;
    if (s && s.getVideoTracks()[0]?.getSettings) {
      deviceId = s.getVideoTracks()[0].getSettings().deviceId || null;
    }
  } catch { /* ignore */ }

  try {
    currentControls = await reader.decodeFromVideoDevice(deviceId, els.video, (result, err, controls) => {
      if (!zxingActive) return;

      if (result) {
        const text = result.getText ? result.getText() : String(result.text || '');
        const now = Date.now();
        // Debounce: ignore the same code for 2 seconds
        if (text && (text !== lastCode || (now - lastAt) > 2000)) {
          lastCode = text; lastAt = now;
          setStatus(`Scanned: ${text}`);
          onBarcode(text, result);
        }
      } else if (err && !(err instanceof ZXingBrowser.NotFoundException)) {
        console.debug('[ZXing error]', err);
      }
    });

    setStatus('Scanning… point camera at the barcode.');
  } catch (e) {
    setStatus(`ZXing start error: ${e?.message || e}`, true);
  }
}

function stopDecoding() {
  zxingActive = false;
  try { currentControls?.stop(); } catch { /* noop */ }
  try { ZXingBrowser.BrowserCodeReader._stopStreams(els.video); } catch { /* noop */ }
  try { reader?.reset(); } catch { /* noop */ }
  reader = null;
  currentControls = null;
}

/* ---------- Barcode handler: lookup + warnings ---------- */
function onBarcode(barcode /*, result */) {
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
  let t = s.toLowerCase().trim();
  t = t.replace(/\([^)]*\)/g, '');          // remove parentheses content
  t = t.replace(/[\s\-_]+/g, ' ').trim();   // collapse separators
  t = t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''); // strip non-alnum ends
  return t;
}
function buildIngredientsList(text, arr) {
  if (arr && arr.length) {
    return uniq(arr.map(x => normalizeIngredient(x?.text || '')).filter(Boolean));
  }
  if (!text) return [];
  return uniq(text.split(/[,\[\];]+/).map(normalizeIngredient).filter(Boolean));
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
    const name = p.product_name || 'Unknown';
    const brand = p.brands || '';
    const ingTxt = (p.ingredients_text || '').trim();
    const ingArr = Array.isArray(p.ingredients) ? p.ingredients : [];
    const ingredientsList = buildIngredientsList(ingTxt, ingArr);

    if (els.resName) els.resName.textContent = name || '—';
    if (els.resBrand) els.resBrand.textContent = brand || '—';
    if (els.resBarcode) els.resBarcode.textContent = barcode || '—';
    if (els.resIngredients) els.resIngredients.textContent = (ingredientsList.join(', ') || '—');

    const matches = matchIngredients(ingredientsList, avoidList);
    renderWarnings(name, matches);
    setStatus('Ingredients loaded. Matches evaluated.');
  } catch (e) {
    setStatus('Lookup failed. Try again.', true);
    console.error('OFF fetch error:', e);
  }
}

/* ---------- Start Button: robust wiring ---------- */
function wireStartTriggers() {
  if (els.start) { els.start.disabled = false; els.start.setAttribute('type','button'); }
  const selectors = ['#start', '#start-button', '.start-camera', '[data-start-camera]'];
  document.addEventListener('click', (evt) => {
    const target = evt.target.closest(selectors.join(','));
    if (target) {
      evt.preventDefault();
      evt.stopPropagation();
      if (target.tagName === 'BUTTON') target.type = 'button';
      startCamera().catch(err => setStatus(err?.message || String(err), true));
    }
  }, { capture: true });

  // Also wire the direct reference (redundant but harmless)
  if (els.start) {
    els.start.addEventListener('click', (evt) => {
      evt.preventDefault(); evt.stopPropagation();
      els.start.type = 'button';
      startCamera().catch(err => setStatus(err?.message || String(err), true));
    });
  }
}

/* ---------- Other controls ---------- */
function wireOtherControls() {
  if (els.flip) els.flip.addEventListener('click', (e) => { e.preventDefault(); flipCamera(); });
  if (els.capture) els.capture.addEventListener('click', (e) => { e.preventDefault(); captureFrame(); });
  if (els.stop) els.stop.addEventListener('click', (e) => { e.preventDefault(); stopStream(); });
  // Stop camera when the tab is hidden (saves battery)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopStream();
  });
}

/* ---------- Init ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  wireStartTriggers();
  wireOtherControls();

  // Optional auto-start on non‑iOS (comment out if you prefer manual only)
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) {
    try { await startCamera(); } catch { /* user can tap Start */ }
  }
});

// Expose manual start for debugging in console
window.SafeScanStart = () => startCamera();
``
