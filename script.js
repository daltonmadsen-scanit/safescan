
/* SafeScan - drop-in script.js
   - Uses existing DOM IDs (no HTML changes needed)
   - BarcodeDetector (native) with ZXing fallback
   - Open Food Facts lookup
   - Ingredient matching against avoid_list.json
*/

(async function () {
  'use strict';

  // ---------- DOM ----------
  const videoEl            = document.getElementById('video');
  const startBtn           = document.getElementById('startScanBtn');
  const stopBtn            = document.getElementById('stopScanBtn');
  const supportWarning     = document.getElementById('supportWarning');

  const barcodeInput       = document.getElementById('barcodeInput');
  const lookupBtn          = document.getElementById('lookupBtn');

  const ingredientsText    = document.getElementById('ingredientsText');
  const checkIngredientsBtn= document.getElementById('checkIngredientsBtn');

  const resultSec          = document.getElementById('result');
  const productMeta        = document.getElementById('productMeta');
  const matchSummary       = document.getElementById('matchSummary');
  const matches            = document.getElementById('matches');

  // ---------- Config & data ----------
  const avoid = await fetch('avoid_list.json').then(r => r.json()).catch(() => ({ match_keywords: [] }));
  const matchKeywords = new Set(avoid.match_keywords || []);
  const hasNativeDetector = ('BarcodeDetector' in window);

  if (!hasNativeDetector && supportWarning) supportWarning.hidden = false;

  // ---------- Utilities ----------
  const norm = s => (s || '')
    .toLowerCase()
    .replace(/\([^\)]*\)/g, '')      // remove (...) content
    .replace(/[^a-z0-9]+/g, ' ')     // non-alphanumerics -> space
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim();

  function findMatches(arr) {
    const hits = new Set();
    for (const raw of arr) {
      const t = norm(raw);
      if (!t) continue;
      for (const key of matchKeywords) {
        if (key && t.includes(key)) hits.add(key);
      }
    }
    return Array.from(hits);
  }

  function renderResult(meta, hits) {
    resultSec.hidden = false;
    productMeta.innerHTML = meta || '';
    if (hits.length === 0) {
      matchSummary.className = 'safe';
      matchSummary.textContent = '✅ No avoid ingredients detected.';
      matches.innerHTML = '';
    } else {
      matchSummary.className = 'unsafe';
      matchSummary.textContent = `⚠️ Avoid: ${hits.length} potential matches found`;
      matches.innerHTML = `<h3>Matched terms</h3><ul>${hits.map(h => `<li>${h}</li>`).join('')}</ul>`;
    }
  }

  function setIOSPreviewAttributes(video) {
    // iOS Safari requires these for auto-playing camera preview to render
    // (playsinline + muted). [1](https://geekflare.com/cybersecurity/github-credentials-scanner/)
    video.setAttribute('playsinline', '');
    video.muted = true;
  }

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load: ${src}`));
      document.head.appendChild(s);
    });
  }

  // ---------- Open Food Facts lookup ----------
  async function lookupBarcode(code) {
    const clean = (code || '').replace(/[^0-9]/g, '');
    if (!clean) {
      alert('Enter a valid numeric barcode (UPC/EAN).');
      return;
    }

    resultSec.hidden = false;
    productMeta.textContent = 'Looking up product...';
    matchSummary.textContent = '';
    matches.innerHTML = '';

    const urls = [
      `https://world.openfoodfacts.org/api/v2/product/${clean}?fields=product_name,brands,ingredients,ingredients_text,ingredients_tags`,
      `https://world.openfoodfacts.org/api/v0/product/${clean}.json`
    ];

    let product = null;
    for (const url of urls) {
      try {
        // Browser forbids setting custom User-Agent header—do not include it. [2](https://openscan-org.github.io/OpenScan-Doc/)
        const resp = await fetch(url);
        const data = await resp.json();
        if (data && (data.product || data.status === 1)) {
          product = data.product || data;
          break;
        }
      } catch (e) {
        console.error('Lookup failed', e);
      }
    }

    if (!product) {
      renderResult(`<strong>Barcode:</strong> ${clean} — Product not found in Open Food Facts.`, []);
      return;
    }

    const name  = product.product_name || product.name || '(unknown)';
    const brand = product.brands || '';

    // Prefer structured ingredient list
    let ingredientsArr = [];
    if (Array.isArray(product.ingredients)) {
      ingredientsArr = product.ingredients
        .map(i => i.text || i.id || i.orig || '')
        .filter(Boolean);
    }

    // Fallback to text split on common separators
    if ((!ingredientsArr || ingredientsArr.length === 0) && product.ingredients_text) {
      ingredientsArr = product.ingredients_text
        .split(/[;,.\|]+/)
        .map(s => s.trim())
        .filter(Boolean);
    }

    const hits = findMatches(ingredientsArr);
    const metaHtml = `<div><strong>${name}</strong> ${brand ? `— ${brand}` : ''}<br/><small>Barcode: ${clean}</small></div>`;
    renderResult(metaHtml, hits);
  }

  lookupBtn.addEventListener('click', () => lookupBarcode(barcodeInput.value));

  checkIngredientsBtn.addEventListener('click', () => {
    const arr = ingredientsText.value
      .split(/[;,.\|]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const hits = findMatches(arr);
    renderResult('<strong>Manual ingredients check</strong>', hits);
  });

  // ---------- Scanning (camera) ----------
  let mediaStream = null;
  let detector    = null;
  let scanTimer   = null;

  async function startScan() {
    if (hasNativeDetector) {
      return startScanNative();
    }
    return startScanZXing();
  }

  async function startScanNative() {
    try {
      detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'code_128'] });
    } catch (e) {
      console.error('BarcodeDetector init failed', e);
      alert('BarcodeDetector failed to initialize. Switching to ZXing fallback.');
      return startScanZXing();
    }

    try {
      setIOSPreviewAttributes(videoEl);

      // getUserMedia only works in secure contexts (HTTPS / localhost). [2](https://openscan-org.github.io/OpenScan-Doc/)
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });

      videoEl.srcObject = mediaStream;

      // Wait for metadata (helps iOS) before play
      await new Promise(res => {
        if (videoEl.readyState >= 2) return res();
        videoEl.onloadedmetadata = res;
      });

      await videoEl.play();

      startBtn.disabled = true;
      stopBtn.disabled  = false;

      scanTimer = setInterval(async () => {
        try {
          const codes = await detector.detect(videoEl);
          if (codes && codes.length) {
            const raw = codes[0].rawValue || codes[0].value || '';
            if (raw) {
              clearInterval(scanTimer);
              await lookupBarcode(raw);
              stopScan();
            }
          }
        } catch {
          // ignore transient detection errors
        }
      }, 500);

    } catch (e) {
      console.error('Camera access failed (native)', e);
      alert('Camera access failed. Ensure HTTPS and allow camera permissions in the browser and OS settings.');
    }
  }

  async function startScanZXing() {
    try {
      if (!window.ZXing) {
        // Auto-load ZXing UMD build (no HTML change needed)
        await loadScript('https://unpkg.com/@zxing/library@latest/umd/index.min.js');
      }

      const codeReader = new ZXing.BrowserMultiFormatReader();
      const devices = await codeReader.listVideoInputDevices();

      // Prefer a rear/environment camera when available
      let deviceId = undefined;
      const back = devices.find(d => /back|rear|environment/i.test(d.label));
      deviceId = back ? back.deviceId : (devices[0] ? devices[0].deviceId : undefined);

      setIOSPreviewAttributes(videoEl);

      startBtn.disabled = true;
      stopBtn.disabled  = false;

      await codeReader.decodeFromVideoDevice(deviceId, videoEl, async (result, err) => {
        if (result && result.text) {
          await lookupBarcode(result.text);
          // stop the reader and camera
          try { codeReader.reset(); } catch {}
          stopScan();
        }
      });

    } catch (e) {
      console.error('ZXing start failed', e);
      alert('ZXing library is not available or failed to start. Use manual barcode entry.');
    }
  }

  function stopScan() {
    startBtn.disabled = false;
    stopBtn.disabled  = true;

    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }

    if (videoEl) { try { videoEl.pause(); } catch {} }

    if (mediaStream) {
      try { mediaStream.getTracks().forEach(t => t.stop()); } catch {}
      mediaStream = null;
    }
  }

  startBtn.addEventListener('click', startScan);
  stopBtn.addEventListener('click', stopScan);

  // ---------- Optional: list media devices (debug aid) ----------
  if (navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices()
      .then(devs => devs.forEach(d => console.log(`device: ${d.kind} — ${d.label || '(no label)'} — ${d.deviceId}`)))
      .catch(e => console.warn('enumerateDevices failed:', e));
  }
})();
