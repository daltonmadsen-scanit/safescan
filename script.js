
/* ============================================================================
   SafeScan – Auto camera + Auto scan + Auto populate (native + ZXing fallback)
   - Robust dynamic ZXing loader (Option B) with suppression if native is running
   - Token expansion from avoid list + always-on tokenized partial matching
   - Render warnings: ONLY the matched term(s) per level
   ============================================================================ */

/* -------- DOM -------- */
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
  resOK: byId('res-ok')
};

/* -------- Config -------- */
const AUTO_STOP_AFTER_DECODE = true; // set to false to keep scanning after first decode
const SCAN_INTERVAL_MS = 200;

// Matching thresholds
const TERM_TOKEN_MIN_LEN = 5;     // tokens added from avoid entries must be ≥ 5 chars
const PARTIAL_TOKEN_MIN_LEN = 5;  // partial includes() allowed for terms ≥ 5 chars

/* -------- State -------- */
let currentStream = null;
let usingDeviceId = null;
let avoidList = [];
let lastCode = null, lastAt = 0;
let rafId = null;                 // for BarcodeDetector loop
let barcodeDetector = null;       // native
let zxingReader = null;           // ZXing fallback
let zxingControls = null;         // ZXing controls
let scanning = false;
let nativeStarted = false;        // NEW: remember if native scanner is active
let zxLoaded = false;             // NEW: remember if ZXing UMD loaded successfully

/* -------- Helpers -------- */
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

/* -------- Avoid list -------- */

// strip diacritics: "açai" -> "acai"
function stripDiacritics(t) {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Tokenize while KEEPING inner words (e.g., Wheat (semolina) -> includes "semolina")
function tokenizeForTerms(str) {
  if (!str) return [];
  const keep = stripDiacritics(String(str).toLowerCase()).replace(/[()]/g, ' ');
  const tokens = keep.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.filter(t => t.length >= TERM_TOKEN_MIN_LEN);
}

// Normalize an avoid-list entry and enrich with tokens from name/synonyms
function normalizeAvoid(raw) {
  const name = String(raw?.name ?? raw?.term ?? '').trim().toLowerCase();
  const level = Number(raw?.level ?? raw?.severity ?? 0);
  const synonyms = Array.isArray(raw?.synonyms) ? raw.synonyms : [];

  // base terms from name+synonyms
  const baseTerms = [name, ...synonyms]
    .filter(Boolean)
    .map(t => stripDiacritics(String(t).toLowerCase()));

  // tokens from name and synonyms (captures "semolina")
  const expandedTokens = new Set();
  for (const s of [raw?.name, ...(synonyms ?? [])]) {
    tokenizeForTerms(s).forEach(tok => expandedTokens.add(tok));
  }

  // unique final terms
  const termSet = new Set(baseTerms);
  expandedTokens.forEach(tok => termSet.add(tok));
  const terms = Array.from(termSet).filter(Boolean);

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
    setStatus('Avoid list failed to load.', true);
  }
}

/* -------- Camera -------- */
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
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No video tracks returned.');
  }
  if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
  currentStream = stream;
  try {
    usingDeviceId = tracks[0]?.getSettings?.().deviceId ?? null;
  } catch {
    usingDeviceId = null;
  }
  els.video.srcObject = stream;
  els.video.setAttribute('playsinline', 'true');
  els.video.setAttribute('autoplay', 'true');
  els.video.muted = true;
  try { await els.video.play(); } catch { /* iOS may require user gesture */ }
}

/* -------- Scanner: native fast-path -------- */
async function startNativeScan() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    barcodeDetector = new BarcodeDetector({
      formats: [
        'ean_13','ean_8','upc_a','upc_e','code_128','code_39',
        'qr_code','itf','codabar','data_matrix','pdf417','aztec'
      ]
    });
  } catch {
    barcodeDetector = null;
    return false;
  }

  const ctx = els.canvas.getContext('2d');
  scanning = true;
  nativeStarted = true;   // mark native as active
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

/* -------- Robust ZXing dynamic loader (Option B) -------- */
async function loadZXingUMD(timeoutMs = 8000) {
  if (window.ZXingBrowser?.BrowserMultiFormatReader) { zxLoaded = true; return true; }

  const SOURCES = [
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js',
    'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js'
  ];

  const tryLoad = (src) => new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });

  for (const src of SOURCES) {
    const ok = await tryLoad(src);
    if (!ok) continue;

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (window.ZXingBrowser?.BrowserMultiFormatReader) { zxLoaded = true; return true; }
      await new Promise(r => setTimeout(r, 50));
    }
  }
  return !!(window.ZXingBrowser?.BrowserMultiFormatReader);
}

/* -------- Scanner: ZXing fallback (uses dynamic loader) -------- */
async function startZXingScan() {
  // If native scanner already started, do NOT run ZXing or report errors.
  if (nativeStarted) return false;

  // Ensure ZXing UMD is present; only report an error if native is unavailable.
  if (!window.ZXingBrowser?.BrowserMultiFormatReader) {
    const loaded = await loadZXingUMD();
    if (!loaded || !window.ZXingBrowser?.BrowserMultiFormatReader) {
      // Only a real error if native didn't start
      if (!nativeStarted) {
        setStatus('ZXing not loaded. Check the script tag order.', true);
      }
      return false;
    }
  }

  try {
    zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
    scanning = true;
    const deviceId = usingDeviceId ?? null;

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
