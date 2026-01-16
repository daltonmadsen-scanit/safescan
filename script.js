
/* ============================================================================
   SafeScan – Strict triggers for Level 2 & 3
   - Loads triggers_level2_3_array.json (array: {name, level, synonyms[]})
   - Strict matching:
       • default = whole-word/phrase only (no loose substrings)
       • allow E-number flexibility (E414, E-414, E 414)
       • allow space↔hyphen flexibility (carboxymethyl cellulose vs carboxymethyl-cellulose)
       • avoid generic single-word false positives (e.g., "oil", "salt", "cheese")
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
  resOK: byId('res-ok'),
};

/* -------- Config -------- */
const AUTO_STOP_AFTER_DECODE = true;
const SCAN_INTERVAL_MS = 200;

// STRICT MATCH options
const STRICT_WORD_BOUNDARY_ONLY = true;   // disallow generic substring matching
const ALLOW_HYPHEN_SPACE_FLEX = true;     // allow space<->hyphen swaps inside a term
const ALLOW_E_NUMBER_FLEX = true;         // E621 == E-621 == E 621

// If a term is a single "generic" word (e.g. 'oil', 'salt', 'butter'), require a longer phrase.
const GENERIC_SINGLE_WORDS = new Set([
  'oil','salt','pepper','cheese','milk','cream','butter','liver','flour',
  'gum','starch','sugar','vinegar','syrup','yeast','protein','collagen',
  'broth','powder','bean','beans','pepperoni','pasta'
]);

const RETAIL_FORMATS = new Set([
  'ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','codabar'
]);

/* -------- State -------- */
let currentStream = null;
let usingDeviceId = null;
let avoidList = [];
let lastCode = null, lastAt = 0;
let rafId = null;
let barcodeDetector = null;    // native
let zxingReader = null;        // ZXing fallback
let zxingControls = null;
let scanning = false;
let nativeStarted = false;
let zxLoaded = false;
let zxingErrorShown = false;

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

async function hasNativeRetailSupport() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    const supported = await BarcodeDetector.getSupportedFormats?.();
    return Array.isArray(supported) && supported.some((fmt) => RETAIL_FORMATS.has(fmt));
  } catch {
    return false;
  }
}

/* -------- Avoid list loading -------- */
function stripDiacritics(t) {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Keep tokens >=5 chars for robustness (can tweak if needed)
 */
function tokenizeForTerms(str) {
  if (!str) return [];
  const keep = stripDiacritics(String(str).toLowerCase()).replace(/[\(\)\[\]]/g, ' ');
  const tokens = keep.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.filter((t) => t.length >= 5);
}

/**
 * Build a REGEX-safe pattern for a term:
 * - word boundaries
 * - optional space<->hyphen flexibility
 * - optional E-number flexibility
 */
function buildStrictPatternForTerm(term) {
  let t = stripDiacritics(String(term).toLowerCase().trim());
  if (!t) return null;

  // Escape regex, then allow space<->hyphen flexibility
  let escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (ALLOW_HYPHEN_SPACE_FLEX) {
    // Replace literal spaces with [\s-]+ (one or more space or hyphen)
    escaped = escaped.replace(/\s+/g, '[\\s-]+');
  }

  // E-number flex: transform 'e123' to pattern allowing E 123 / E-123
  if (ALLOW_E_NUMBER_FLEX) {
    escaped = escaped.replace(/\be\s*[- ]?\s*(\d{3,4})\b/gi, '[eE][\\s-]?$1');
  }

  // Word boundaries around the whole phrase
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, 'i');
}

/**
 * Adapt a raw entry {name, level, synonyms[]} into:
 * { name, level, terms: [...], patterns: [RegExp, ...] }
 * where 'name' should be Item_Concat from your JSON.
 */
function normalizeAvoid(raw) {
  const nameRaw = String(raw?.name ?? '').trim();     // Item_Concat as canonical
  const level   = Number(raw?.level ?? 0);
  const synonyms = Array.isArray(raw?.synonyms) ? raw.synonyms : [];

  // Include full phrases (canonical + synonyms) and expanded tokens
  const fullPhrases = [nameRaw, ...synonyms]
    .filter(Boolean)
    .map((t) => stripDiacritics(String(t).toLowerCase().trim()));

  const tokenSet = new Set();
  for (const s of [nameRaw, ...(synonyms ?? [])]) {
    tokenizeForTerms(s).forEach((tok) => tokenSet.add(tok));
  }

  // Strict term policy:
  //  - Always keep full phrases
  //  - Keep tokens unless they are too generic (e.g., "oil", "salt")
  const terms = new Set(fullPhrases);
  for (const tok of tokenSet) {
    if (!GENERIC_SINGLE_WORDS.has(tok)) {
      terms.add(tok);
    }
  }

  // Build regex patterns for all terms
  const patterns = [];
  for (const term of terms) {
    const pat = buildStrictPatternForTerm(term);
    if (pat) patterns.push(pat);
  }

  return {
    name: nameRaw,         // human-readable canonical (Item_Concat)
    level,
    terms: Array.from(terms),
    patterns               // compiled regexes (strict)
  };
}

/**
 * Load the Level 2 + Level 3 triggers (array shape).
 * IMPORTANT: this file must be in the same folder as index.html
 */
async function loadAvoidList() {
  try {
    const res = await fetch('triggers_level2_3_array.json', { cache: 'no-store' });
    const data = await res.json();
    const arr  = Array.isArray(data) ? data : [];

    // Normalize + compile
    avoidList = arr
      .filter(e => e && (e.level === 2 || e.level === 3))
      .map(normalizeAvoid);

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
        audio: false,
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
  try { await els.video.play(); } catch {}
}

/* -------- Native scan -------- */
async function startNativeScan() {
  if (!('BarcodeDetector' in window)) return false;

  try {
    barcodeDetector = new BarcodeDetector({
      formats: [
        'ean_13','ean_8','upc_a','upc_e','code_128','code_39',
        'qr_code','itf','codabar','data_matrix','pdf417','aztec'
      ],
    });
  } catch {
    barcodeDetector = null;
    return false;
  }

  const ctx = els.canvas.getContext('2d');
  scanning = true;
  nativeStarted = true;

  let lastTick = 0;

  const loop = (ts) => {
    if (!scanning) return;
    rafId = requestAnimationFrame(loop);

    if (ts - lastTick < SCAN_INTERVAL_MS) return;
    lastTick = ts;

    const w = els.video.videoWidth, h = els.video.videoHeight;
    if (!w || !h) return;

    els.canvas.width = w;
    els.canvas.height = h;
    ctx.drawImage(els.video, 0, 0, w, h);

    barcodeDetector.detect(els.canvas).then((codes) => {
      if (!codes || !codes.length) return;
      const c = codes[0];
      const text = c.rawValue || c.data || '';
      if (!text) return;

      const now = Date.now();
      if (text && (text !== lastCode || (now - lastAt) > 1500)) {
        lastCode = text;
        lastAt = now;
        setStatus(`Scanned: ${text}`);
        onBarcode(text, { format: c.format });
        if (AUTO_STOP_AFTER_DECODE) stopScanning();
      }
    }).catch(() => {});
  };

  rafId = requestAnimationFrame(loop);
  setStatus('Scanning (native)… point camera at the barcode.');
  return true;
}

/* -------- ZXing fallback -------- */
async function loadZXingUMD(timeoutMs = 8000) {
  if (window.ZXingBrowser?.BrowserMultiFormatReader) {
    zxLoaded = true;
    return true;
  }

  const SOURCES = [
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js',
    'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js'
  ];

  const tryLoad = (src) =>
    new Promise((resolve) => {
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
      if (window.ZXingBrowser?.BrowserMultiFormatReader) {
        zxLoaded = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return !!window.ZXingBrowser?.BrowserMultiFormatReader;
}

async function startZXingScan() {
  if (nativeStarted) return false;

  if (!window.ZXingBrowser?.BrowserMultiFormatReader) {
    const loaded = await loadZXingUMD();
    if (!loaded && !nativeStarted && !zxingErrorShown) {
      zxingErrorShown = true;
      setStatus('ZXing not loaded.', true);
      return false;
    }
  }

  try {
    zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
    scanning = true;

    const deviceId = usingDeviceId ?? null;

    zxingControls = await zxingReader.decodeFromVideoDevice(
      deviceId,
      els.video,
      (result) => {
        if (!scanning) return;
        if (result) {
          const text = result.getText();
          const now = Date.now();
          if (text && (text !== lastCode || (now - lastAt) > 1500)) {
            lastCode = text;
            lastAt = now;
            setStatus(`Scanned: ${text}`);
            onBarcode(text, result);
            if (AUTO_STOP_AFTER_DECODE) stopScanning();
          }
        }
      }
    );

    setStatus('Scanning (ZXing)… point camera at the barcode.');
    return true;
  } catch (e) {
    setStatus(`ZXing start error: ${e?.message ?? e}`, true);
    return false;
  }
}

function stopScanning() {
  scanning = false;
  if (rafId) cancelAnimationFrame(rafId);
  try { zxingControls?.stop(); } catch {}
  try { ZXingBrowser?.BrowserCodeReader?._stopStreams?.(els.video); } catch {}
  try { zxingReader?.reset?.(); } catch {}
}

/* -------- Barcode handler -------- */
function onBarcode(barcode /*, meta */) {
  fetchAndDisplayProduct(barcode);
}

/* -------- Ingredients parsing & STRICT matching -------- */
function uniq(list) {
  const s = new Set();
  const out = [];
  for (const x of list) { if (!s.has(x)) { s.add(x); out.push(x); } }
  return out;
}

// Keep inner words from parentheses so "(canola, soybean)" survives
function normalizeIngredient(s) {
  if (!s) return '';
  let t = stripDiacritics(String(s).toLowerCase().trim());
  t = t.replace(/[()]/g, ' ');                    // keep inner words
  t = t.replace(/[\s\-_]+/g, ' ').trim();
  t = t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return t;
}

function buildIngredientsList(text, arr) {
  if (arr && arr.length)
    return uniq(arr.map((x) => normalizeIngredient(x?.text ?? '')).filter(Boolean));

  if (!text) return [];
  const pre = text.replace(/[()]/g, ',');         // split inner sub-ingredients
  return uniq(pre.split(/[,\[\];]+/).map(normalizeIngredient).filter(Boolean));
}

/**
 * STRICT matching:
 *   - Try every compiled pattern (whole phrase / word-boundary)
 *   - No general substring fallback (unless term is compiled to allow hyphen/space or E-number forms)
 */
function findStrictHit(ingredients, entry) {
  for (const ing of ingredients) {
    for (const rx of entry.patterns) {
      if (rx.test(ing)) {
        return ing.match(rx)?.[0] ?? entry.name; // return matched span
      }
    }
  }
  return null;
}

function matchIngredients(ingredients, avoid) {
  const lvl2 = [], lvl3 = [];
  for (const entry of avoid) {
    if (!entry || !entry.patterns?.length || !entry.level) continue;
    const hit = findStrictHit(ingredients, entry);
    if (hit) (entry.level === 3 ? lvl3 : lvl2).push({ term: hit, name: entry.name });
  }
  return { lvl2, lvl3 };
}

function renderWarnings(matches) {
  const { lvl2, lvl3 } = matches;

  const setList = (ul, items, noneText) => {
    if (!ul) return;
    ul.innerHTML = '';
    if (!items.length) {
      ul.innerHTML = `<li>${noneText}</li>`;
      return;
    }
    items.forEach((m) => {
      const li = document.createElement('li');
      li.textContent = m.term; // show matched span only
      ul.appendChild(li);
    });
  };

  setList(els.resLvl3, lvl3, 'None');
  setList(els.resLvl2, lvl2, 'None');
  if (els.resOK) {
    els.resOK.innerHTML = (!lvl2.length && !lvl3.length)
      ? '<li>No flagged ingredients detected</li>'
      : '<li>—</li>';
  }
}

/* -------- Product lookup (OpenFoodFacts) -------- */
async function fetchAndDisplayProduct(barcode) {
  setStatus(`Looking up ${barcode}…`);
  const base = 'https://world.openfoodfacts.org/api/v2/product/';
  const fields = 'product_name,brands,ingredients_text,ingredients';
  const url = `${base}${encodeURIComponent(barcode)}?fields=${encodeURIComponent(fields)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const p = data?.product ?? {};

    const name = p.product_name ?? 'Unknown';
    const brand = p.brands ?? '';
    const ingTxt = (p.ingredients_text ?? '').trim();
    const ingArr = Array.isArray(p.ingredients) ? p.ingredients : [];

    const ingredientsList = buildIngredientsList(ingTxt, ingArr);

    els.resName.textContent = name || '—';
    els.resBrand.textContent = brand || '—';
    els.resBarcode.textContent = barcode || '—';
    els.resIngredients.textContent = ingredientsList.join(', ') || '—';

    const matches = matchIngredients(ingredientsList, avoidList);
    renderWarnings(matches);

    setStatus('Ingredients loaded. Matches evaluated.');
  } catch (e) {
    setStatus('Lookup failed. Try again.', true);
    console.error('OFF fetch error:', e);
  }
}

/* -------- Start camera (exposed for iOS tap-to-start) -------- */
window.startCameraApp = async function () {
  try {
    await openStream(true);
    const canNativeRetail = await hasNativeRetailSupport();
    const okNative = canNativeRetail ? await startNativeScan() : false;
    if (!okNative) await startZXingScan();
  } catch (e) {
    setStatus(`Camera error: ${e?.name ?? e?.message ?? e}`, true);
  }
};

/* -------- Boot -------- */
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

  if (els.tapPrompt) els.tapPrompt.style.display = 'flex';

  if (isIOS && els.tapPrompt && els.tapStart) {
    els.tapStart.onclick = async () => {
      try { await window.startCameraApp(); }
      catch (e) { setStatus(`Camera error: ${e?.name ?? e?.message ?? e}`, true); }
    };
  } else {
    try {
      await openStream(true);
      const canNativeRetail = await hasNativeRetailSupport();
      const okNative = canNativeRetail ? await startNativeScan() : false;
      if (!okNative) await startZXingScan();
    } catch (e) {
      setStatus(`Camera error: ${e?.name ?? e?.message ?? e}`, true);
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
