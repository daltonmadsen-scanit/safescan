
// ===== SafeScan Mobile Camera + Barcode → Ingredients + Warnings =====
// Works over HTTPS (GitHub Pages). Scans barcodes with ZXing-JS and
// looks up ingredients via Open Food Facts (OFF) v2 API.
// OFF docs/examples: https://openfoodfacts.github.io/openfoodfacts-server/api/tutorial-off-api/
//
// Expected avoid_list.json structure (repo root):
// [
//   { "name": "almond", "level": 2, "synonyms": ["almonds", "almond flour"] },
//   { "name": "casein",  "level": 3, "synonyms": ["sodium caseinate", "caseinate"] },
//   ...
// ]
//
// If your schema differs (e.g., "severity" instead of "level"), see normalizeAvoidItem() below.

(() => {
  // --- UI elements ---
  const els = {
    video:   document.getElementById('preview'),
    status:  document.getElementById('camera-status'),
    start:   document.getElementById('start'),
    flip:    document.getElementById('flip'),
    capture: document.getElementById('capture'),
    stop:    document.getElementById('stop'),
    canvas:  document.getElementById('snapshot'),
    // Results
    resName: document.getElementById('res-name'),
    resBrand: document.getElementById('res-brand'),
    resBarcode: document.getElementById('res-barcode'),
    resIngredients: document.getElementById('res-ingredients'),
    resLvl2: document.getElementById('res-lvl2'),
    resLvl3: document.getElementById('res-lvl3'),
    resOK: document.getElementById('res-ok'),
  };

  let currentStream = null;
  let usingDeviceId = null;
  let facing = 'environment';
  let zxingReader = null;
  let zxingActive = false;
  let avoidList = [];
  let lastCode = null;
  let lastFetchTs = 0;

  const isSecure =
    location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';

  // --- Status helper ---
  function setStatus(msg, isError = false) {
    console.log('[SafeScan]', msg);
    if (els.status) {
      els.status.textContent = msg;
      els.status.style.color = isError ? '#c62828' : '#8be28b';
    }
  }

  // --- Controls helper ---
  function enableControls(started) {
    els.start.disabled   = started;
    els.flip.disabled    = !started;
    els.capture.disabled = !started;
    els.stop.disabled    = !started;
  }

  // --- Normalize avoid list entries ---
  function normalizeAvoidItem(raw) {
    const name = String(raw.name || raw.term || '').trim().toLowerCase();
    const level = Number(raw.level ?? raw.severity ?? 0);
    const synonyms = Array.isArray(raw.synonyms) ? raw.synonyms : [];
    const allTerms = [name, ...synonyms].filter(Boolean).map(t => t.toLowerCase());
    return { name, level, terms: allTerms };
  }

  // --- Load avoid_list.json once ---
  async function loadAvoidList() {
    try {
      const res = await fetch('avoid_list.json', { cache: 'no-store' });
      const data = await res.json();
      avoidList = Array.isArray(data) ? data.map(normalizeAvoidItem) : [];
      setStatus(`Avoid list loaded (${avoidList.length} items).`);
    } catch (e) {
      setStatus('Could not load avoid_list.json. Warnings will be unavailable.', true);
      avoidList = [];
    }
  }

  // --- Camera & ZXing setup ---
  if (els.video) {
    els.video.setAttribute('playsinline', 'true');
    els.video.setAttribute('autoplay', 'true');
    els.video.muted = true;
  }

  async function getVideoInputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'videoinput');
    } catch (e) { return []; }
  }

  async function openStream(preferredFacing = 'environment', deviceId = null) {
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } }, audio: false }
      : { video: { facingMode: { ideal: preferredFacing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

    setStatus('Requesting camera…');

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    ensureTracks(stream);
    await attachStream(stream);
    return stream;
  }

  function ensureTracks(stream) {
    const tracks = stream.getVideoTracks();
    if (!tracks || tracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('No video tracks returned by browser.');
    }
  }

  async function attachStream(stream) {
    if (currentStream) currentStream.getTracks().forEach(t => t.stop());
    currentStream = stream;

    const track  = stream.getVideoTracks()[0];
    const info   = track.getSettings?.() || {};
    usingDeviceId = info.deviceId || null;

    els.video.srcObject = stream;
    try { await els.video.play(); } catch {}
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
    els.video.srcObject = null;
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
    if (!currentStream) return;
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
      alert('Open this page over HTTPS (GitHub Pages) or run on localhost.');
      return;
    }
    if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
      setStatus('getUserMedia() not supported in this browser.', true);
      alert('Your browser does not support camera access. Update to a modern browser.');
      return;
    }
    await loadAvoidList();
    try {
      await openStream(facing, forceDeviceId);
    } catch (err) {
      alert('Camera failed to start.\n\n' + (err?.message || err));
    }
  }

  // ===== ZXing continuous decoding =====
  async function startDecoding() {
    if (!window.ZXing || !window.ZXing.BrowserMultiFormatReader) {
      setStatus('ZXing library not loaded. Check CDN <script> order.', true);
      return;
    }
    stopDecoding();
    zxingReader = new window.ZXing.BrowserMultiFormatReader(250);
    zxingActive = true;

    try {
      await zxingReader.decodeFromVideoDevice(usingDeviceId || null, els.video, (result, err) => {
        if (!zxingActive) return;

        if (result) {
          const code = result.getText ? result.getText() : String(result.text || '');
          if (shouldFetch(code)) {
            lastCode = code;
            lastFetchTs = Date.now();
            fetchAndDisplayProduct(code);
          }
        } else if (err && !(err instanceof window.ZXing.NotFoundException)) {
          console.warn('[ZXing] Error:', err);
        }
      });
      setStatus('Scanning… point camera at the barcode.');
    } catch (e) {
      setStatus('ZXing failed to start decoding: ' + e, true);
    }
  }

  function stopDecoding() {
    if (zxingReader) { try { zxingReader.reset(); } catch {} }
    zxingReader = null;
    zxingActive = false;
  }

  function shouldFetch(code) {
    // Avoid hammering API on the same code repeatedly
    if (!code) return false;
    const now = Date.now();
    if (code !== lastCode) return true;
    return (now - lastFetchTs) > 2000; // 2s debounce
  }

  // ===== Product lookup (Open Food Facts v2) + display =====
  async function fetchAndDisplayProduct(barcode) {
    setStatus(`Looking up ${barcode}…`);

    // Prefer v2 product endpoint; limit fields for performance
    const base = 'https://world.openfoodfacts.org/api/v2/product/';
    const fields = 'product_name,brands,ingredients_text,ingredients';
    const url = `${base}${encodeURIComponent(barcode)}?fields=${encodeURIComponent(fields)}`;

    try {
      const res = await fetch(url);
      const data = await res.json();

      // OFF v2 returns: { code, product: {...}, status, status_verbose }
      const p = data?.product || {};
      const name = p.product_name || 'Unknown';
      const brand = p.brands || '';
      const ingText = (p.ingredients_text || '').trim();
      const ingArray = Array.isArray(p.ingredients) ? p.ingredients.map(x => (x.text || '').trim()).filter(Boolean) : [];

      // Prepare normalized ingredients list
      const ingredientsList = buildIngredientsList(ingText, ingArray);

      // Update UI
      els.resName.textContent = name || '—';
      els.resBrand.textContent = brand || '—';
      els.resBarcode.textContent = barcode || '—';
      els.resIngredients.textContent = (ingredientsList.join(', ') || '—');

      // Match against avoid list
      const matches = matchIngredients(ingredientsList, avoidList);

      // Render warnings; include "Product (ingredient)" format as requested.
      renderWarnings(name, matches);
      setStatus('Ingredients loaded. Matches evaluated.');
    } catch (e) {
      setStatus('Lookup failed. Try again.', true);
      console.error('OFF fetch error:', e);
    }
  }

  function buildIngredientsList(text, arr) {
    // If OFF provides structured list, prefer it; otherwise split text
    if (arr && arr.length) {
      return uniq(arr.map(normalizeIngredient).filter(Boolean));
    }
    if (!text) return [];
    return uniq(
      text.split(/[,;]+/).map(normalizeIngredient).filter(Boolean)
    );
  }

  function normalizeIngredient(s) {
    if (!s) return '';
    // lower-case, trim, remove parentheses content and surrounding punctuation
    let t = s.toLowerCase().trim();
    t = t.replace(/\([^)]*\)/g, '');    // remove (...) notes
    t = t.replace(/[\s\-_/]+/g, ' ').trim(); // collapse separators
    t = t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''); // strip non-alnum edges
    return t;
  }

  function uniq(list) {
    const seen = new Set(); const out = [];
    for (const item of list) { if (!seen.has(item)) { seen.add(item); out.push(item); } }
    return out;
  }

  function matchIngredients(ingredients, avoid) {
    const lvl2 = [];
    const lvl3 = [];

    for (const entry of avoid) {
      if (!entry || !entry.terms || !entry.level) continue;
      const hit = findTermHit(ingredients, entry.terms);
      if (hit) {
        (entry.level === 3 ? lvl3 : lvl2).push({ term: hit, name: entry.name });
      }
    }
    return { lvl2, lvl3 };
  }

  function findTermHit(ingredients, terms) {
    // Whole-word match against normalized ingredients
    for (const t of terms) {
      const needle = t.toLowerCase();
      for (const ing of ingredients) {
        // Exact or contains whole word
        if (ing === needle || new RegExp(`\\b${escapeRegex(needle)}\\b`).test(ing)) {
          return needle;
        }
      }
    }
    return null;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function renderWarnings(productName, matches) {
    const { lvl2, lvl3 } = matches;

    // Clear lists
    [els.resLvl2, els.resLvl3, els.resOK].forEach(ul => { ul.innerHTML = ''; });

    // Level 3
    if (lvl3.length) {
      lvl3.forEach(m => {
        const li = document.createElement('li');
        // Requested format: Product (ingredient)
        li.textContent = `${productName} (${m.term})`;
        els.resLvl3.appendChild(li);
      });
    } else {
      els.resLvl3.innerHTML = '<li>None</li>';
    }

    // Level 2
    if (lvl2.length) {
      lvl2.forEach(m => {
        const li = document.createElement('li');
        li.textContent = `${productName} (${m.term})`;
        els.resLvl2.appendChild(li);
      });
    } else {
      els.resLvl2.innerHTML = '<li>None</li>';
    }

    // OK (no matches)
    if (!lvl2.length && !lvl3.length) {
      els.resOK.innerHTML = '<li>No Level 2 or Level 3 ingredients detected</li>';
    } else {
      els.resOK.innerHTML = '<li>—</li>';
    }
  }

  // --- Wire UI ---
  document.addEventListener('DOMContentLoaded', async () => {
    try { await startCamera(); } catch {}
  });
  els.start?.addEventListener('click', () => startCamera());
  els.flip?.addEventListener('click', () => flipCamera());
  els.capture?.addEventListener('click', () => captureFrame());
  els.stop?.addEventListener('click', () => stopStream());
})();
