
/* ============================================================================
   SafeScan – Auto camera + Auto scan + Auto populate (native + ZXing fallback)
   ============================================================================ */

/* ---------- DOM ---------- */
const byId = (id) => document.getElementById(id);

const els = {
  video: byId('preview'),
  status: byId('camera-status'),
  canvas: byId('snapshot'),
  tapPrompt: byId('tapPrompt'),
  tapStart: byId('tapStart'),
  resName: byId('res-name'),
  resBrand: byId('res-brand'),
  resBarcode: byId('res-barcode'),
  resIngredients: byId('res-ingredients'),
  resLvl2: byId('res-lvl2'),
  resLvl3: byId('res-lvl3'),
  resOK: byId('res-ok'),
};

/* ---------- Config ---------- */
const AUTO_STOP_AFTER_DECODE = true;   // set to false to keep scanning
const SCAN_INTERVAL_MS = 200;

/* ---------- State ---------- */
let currentStream = null;
let usingDeviceId = null;
let avoidList = [];
let lastCode = null, lastAt = 0;

let rafId = null;                      // for BarcodeDetector
let barcodeDetector = null;            // native
let zxingReader = null;                // ZXing fallback
let zxingControls = null;              // ZXing controls
let scanning = false;

/* ---------- Helpers ---------- */
const isSecure =
  location.protocol === 'https:' ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1';

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function setStatus(msg, isError = false) {
  console.log('[SafeScan]', msg);
  if (els.status) {
    els.status.textContent = msg;
    els.status.style.color = isError ? '#c62828' : 'inherit';
  }
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
    avoidList = [];
  }
}

/* ---------- Camera ---------- */
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
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const tracks = stream.getVideoTracks();
  if (!tracks || !tracks.length) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('No video tracks returned.');
  }

  // Attach
  if (currentStream) currentStream.getTracks().forEach(t => t.stop());
  currentStream = stream;
  try { usingDeviceId = tracks[0]?.getSettings?.().deviceId || null; } catch { usingDeviceId = null; }

  els.video.srcObject = stream;
  els.video.setAttribute('playsinline', 'true');
  els.video.setAttribute('autoplay', 'true');
  els.video.muted = true;

  try { await els.video.play(); } catch { /* iOS will start after tap */ }
}

/* ---------- Scanner: native fast-path ---------- */
async function startNativeScan() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    barcodeDetector = new BarcodeDetector({
      formats: [
        'ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code','itf','codabar','data_matrix','pdf417','aztec'
      ]
    });
  } catch { barcodeDetector = null; return false; }

  const ctx = els.canvas.getContext('2d');
  scanning = true;
  let lastTick = 0;

  const loop = (ts) => {
    if (!scanning) return;
    rafId = requestAnimationFrame(loop);
    if (ts - lastTick < SCAN_INTERVAL_MS) return;
    lastTick = ts;

    const w = els.video.videoWidth, h = els.video.videoHeight;
    if (!w || !h) return;

    els.canvas.width = w; els.canvas.height = h;
    ctx.drawImage(els.video, 0, 0, w, h);

    barcodeDetector.detect(els.canvas).then((codes) => {
      if (!codes || !codes.length) return;
      const c = codes[0];
      const text = c.rawValue || c.data || '';
      if (!text) return;
      const now = Date.now();
      if (text && (text !== lastCode || (now - lastAt) > 1500)) {
        lastCode = text; lastAt = now;
        setStatus(`Scanned: ${text}`);
        onBarcode(text, { format: c.format });
        if (AUTO_STOP_AFTER_DECODE) stopScanning();
      }
    }).catch((e) => console.debug('Detector error', e));
  };

  rafId = requestAnimationFrame(loop);
  setStatus('Scanning (native)… point camera at the barcode.');
  return true;
}

/* ---------- Scanner: ZXing fallback ---------- */
async function startZXingScan() {
  // Guard: must use ZXingBrowser (UMD global)
  if (!window.ZXingBrowser || !ZXingBrowser.BrowserMultiFormatReader) {
    // Try dynamic load as a safety net
    await loadZXingUMD();
    if (!window.ZXingBrowser || !ZXingBrowser.BrowserMultiFormatReader) {
      setStatus('ZXing not loaded. Check the script tag order.', true);
      return false;
    }
  }

  try {
    zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
    scanning = true;
    const deviceId = usingDeviceId || null;

    zxingControls = await zxingReader.decodeFromVideoDevice(deviceId, els.video, (result, err) => {
      if (!scanning) return;
      if (result) {
        const text = result.getText();
        const now = Date.now();
        if (text && (text !== lastCode || (now - lastAt) > 1500)) {
          lastCode = text; lastAt = now;
          setStatus(`Scanned: ${text}`);
          onBarcode(text, result);
          if (AUTO_STOP_AFTER_DECODE) stopScanning();
        }
      } else if (err && !(err instanceof ZXingBrowser.NotFoundException)) {
        console.debug('ZXing error', err);
      }
    });

    setStatus('Scanning (ZXing)… point camera at the barcode.');
    return true;
  } catch (e) {
    setStatus(`ZXing start error: ${e?.message || e}`, true);
    return false;
  }
}

function stopScanning() {
  scanning = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  try { zxingControls?.stop(); } catch {}
  try { ZXingBrowser?.BrowserCodeReader?._stopStreams?.(els.video); } catch {}
  try { zxingReader?.reset?.(); } catch {}
}

/* ---------- Dynamic loader (safety net) ---------- */
function loadZXingUMD() {
  return new Promise((resolve) => {
    if (window.ZXingBrowser?.BrowserMultiFormatReader) return resolve();
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => resolve(); // resolve anyway; caller will re-check
    document.head.appendChild(s);
  });
}

/* ---------- Barcode handler ---------- */
function onBarcode(barcode /*, meta */) {
  fetchAndDisplayProduct(barcode);
}

/* ---------- OFF lookup + ingredients ---------- */
function uniq(list) { const s = new Set(); const out = []; for (const x of list) { if (!s.has(x)) { s.add(x); out.push(x); } } return out; }
function normalizeIngredient(s) {
  if (!s) return '';
  let t = s.toLowerCase().trim();
  t = t.replace(/\([^)]*\)/g, '');          // remove parentheses content
  t = t.replace(/[\s\-_]+/g, ' ').trim();   // collapse separators
  t = t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''); // strip non-alnum ends
  return t;
}
function buildIngredientsList(text, arr) {
  if (arr && arr.length) return uniq(arr.map(x => normalizeIngredient(x?.text || '')).filter(Boolean));
  if (!text) return [];
  return uniq(text.split(/[,\[\];]+/).map(normalizeIngredient).filter(Boolean));
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function findTermHit(ingredients, terms) {
  for (const t of terms) {
    const needle = t.toLowerCase();
    for (const ing of ingredients) {
      if (ing === needle || new RegExp(`\\b${escapeRegex(needle)}\\b`).test(ing)) return needle;
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
  const setList = (ul, items, noneText) => {
    if (!ul) return;
    ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = `<li>${noneText}</li>`; return; }
    items.forEach(m => { const li = document.createElement('li'); li.textContent = `${productName} (${m.term})`; ul.appendChild(li); });
  };
  setList(els.resLvl3, lvl3, 'None');
  setList(els.resLvl2, lvl2, 'None');
  if (els.resOK) els.resOK.innerHTML = (!lvl2.length && !lvl3.length) ? '<li>No Level 2 or Level 3 ingredients detected</li>' : '<li>—</li>';
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

    els.resName.textContent = name || '—';
    els.resBrand.textContent = brand || '—';
    els.resBarcode.textContent = barcode || '—';
    els.resIngredients.textContent = (ingredientsList.join(', ') || '—');

    const matches = matchIngredients(ingredientsList, avoidList);
    renderWarnings(name, matches);
    setStatus('Ingredients loaded. Matches evaluated.');
  } catch (e) {
    setStatus('Lookup failed. Try again.', true);
    console.error('OFF fetch error:', e);
  }
}

/* ---------- Boot ---------- */
async function boot() {
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

  if (isIOS) {
    els.tapPrompt.style.display = 'flex';
    const onceStart = async () => {
      els.tapPrompt.style.display = 'none';
      try {
        await openStream(true);
        const okNative = await startNativeScan();
        if (!okNative) await startZXingScan();
      } catch (e) {
        setStatus(`Camera error: ${e?.name || e}`, true);
      }
    };
    els.tapStart.addEventListener('click', onceStart, { once: true });
  } else {
    try {
      await openStream(true);
      const okNative = await startNativeScan();
      if (!okNative) await startZXingScan();
    } catch (e) {
      setStatus(`Camera error: ${e?.name || e}`, true);
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
