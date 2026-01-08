
/* SafeScan - Drop-in script.js (iPhone-ready)
   - Uses existing DOM IDs (no HTML changes)
   - iOS Safari: playsinline + muted; photo-capture fallback if live video fails
   - BarcodeDetector (native) with ZXing fallback (video & photo)
   - Open Food Facts lookup (v2 + v0 fallback)
   - Detailed ingredient matching with parentheses expansion, counts, examples, highlighting
*/

(async function () {
  'use strict';

  // ---------- DOM ----------
  const videoEl             = document.getElementById('video');
  const startBtn            = document.getElementById('startScanBtn');
  const stopBtn             = document.getElementById('stopScanBtn');
  const supportWarning      = document.getElementById('supportWarning');

  const barcodeInput        = document.getElementById('barcodeInput');
  const lookupBtn           = document.getElementById('lookupBtn');

  const ingredientsText     = document.getElementById('ingredientsText');
  const checkIngredientsBtn = document.getElementById('checkIngredientsBtn');

  const resultSec           = document.getElementById('result');
  const productMeta         = document.getElementById('productMeta');
  const matchSummary        = document.getElementById('matchSummary');
  const matches             = document.getElementById('matches');

  // ---------- Env flags ----------
  const ua = navigator.userAgent || '';
  const isIOS     = /iPhone|iPad|iPod/i.test(ua);
  const isSafari  = (!!navigator.vendor && navigator.vendor.includes('Apple')) || /Safari/i.test(ua);
  const isIOSSafari = isIOS && isSafari;

  // ---------- Data ----------
  const avoid = await fetch('avoid_list.json').then(r => r.json()).catch(() => ({ match_keywords: [] }));
  const matchKeywords = new Set(avoid.match_keywords || []);
  const hasNativeDetector = ('BarcodeDetector' in window);

  if (!hasNativeDetector && supportWarning) supportWarning.hidden = false;

  // ---------- Utilities ----------
  // Normalize text for matching (keep parentheses; collapse spaces)
  const norm = s => (s || '')
    .toLowerCase()
    // KEEP parentheses: we want sub-ingredients inside (...)
    .replace(/[^a-z0-9()]+/g, ' ')   // letters/numbers/parentheses
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim();

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
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

  /**
   * Expand compound ingredients like:
   * "cheese (milk, cultures, enzymes)" -> ["cheese (milk, cultures, enzymes)", "milk", "cultures", "enzymes"]
   */
  function expandCompoundIngredients(arr) {
    const out = [];
    for (const raw of (arr || [])) {
      if (!raw) continue;
      out.push(raw); // keep the original for display

      const m = raw.match(/\(([^)]*)\)/);
      if (m && m[1]) {
        const inner = m[1];
        const subs = inner
          .split(/[;,.\|]+/)
          .map(s => s.trim())
          .filter(Boolean);
        out.push(...subs);
      }
    }
    return out;
  }

  /**
   * Detailed matches across array and raw text, including parentheses contents.
   * Returns: [{ term, hits, positions, examples }]
   */
  function findMatchesDetailed(ingredientsArr, rawText = '') {
    const expandedArr = expandCompoundIngredients(ingredientsArr);
    const textForSearch = (expandedArr && expandedArr.length)
      ? expandedArr.join(' | ')
      : (rawText || '');

    const details = [];
    for (const key of matchKeywords) {
      const k = (key || '').trim().toLowerCase();
      if (!k) continue;

      // Loose substring match for examples (display); positions relative to textForSearch
      const loose = new RegExp(escapeRegex(k), 'gi');

      let hits = 0;
      const positions = [];
      const examples  = [];

      let m;
      while ((m = loose.exec(textForSearch)) !== null) {
        hits++;
        positions.push([m.index, m.index + k.length]);
        examples.push(textForSearch.substring(m.index, m.index + k.length));
      }

      if (hits > 0) {
        details.push({ term: k, hits, positions, examples });
      }
    }

    details.sort((a, b) => b.hits - a.hits || a.term.localeCompare(b.term));
    return details;
  }

  /**
   * Wrap matched segments in <mark> for a given display text.
   */
  function highlightMatches(text, details) {
    if (!text) return '';
    if (!details || details.length === 0) return escapeHtml(text);

    // Build ranges from details
    const ranges = [];
    for (const d of details) {
      for (const [start, end] of d.positions) {
        ranges.push({ start, end, term: d.term });
      }
    }
    ranges.sort((a, b) => a.start - b.start);

    // Merge overlapping ranges
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ ...r });
      }
    }

    let html = '';
    let cursor = 0;
    for (const r of merged) {
      if (r.start > cursor) {
        html += escapeHtml(text.slice(cursor, r.start));
      }
      const segment = text.slice(r.start, r.end);
      html += `<mark title="Matched: ${escapeHtml(r.term)}">${escapeHtml(segment)}</mark>`;
      cursor = r.end;
    }
    if (cursor < text.length) {
      html += escapeHtml(text.slice(cursor));
    }
    return html;
  }

  /**
   * Render product meta + detailed matches + highlighted ingredients.
   */
  function renderResultDetailed(meta, ingredientsArr, rawText, details) {
    resultSec.hidden = false;
    productMeta.innerHTML = meta || '';

    const totalHits = details.reduce((sum, d) => sum + d.hits, 0);
    if (details.length === 0) {
      matchSummary.className = 'safe';
      matchSummary.textContent = '✅ No avoid ingredients detected.';
      matches.innerHTML = '';
      return;
    }

    matchSummary.className = 'unsafe';
    matchSummary.textContent = `⚠️ ${details.length} matched terms • ${totalHits} total occurrences`;

    // Build details table
    const tableRows = details.map(d =>
      `<tr>
         <td>${escapeHtml(d.term)}</td>
         <td style="text-align:center">${d.hits}</td>
         <td>${d.examples.slice(0, 6).map(x => `<code>${escapeHtml(x)}</code>`).join(', ')}${d.examples.length > 6 ? ' …' : ''}</td>
       </tr>`
    ).join('');

    const table =
      `<h3>Matched Terms</h3>
       <table class="matches-table">
         <thead>
           <tr><th>Term</th><th>Hits</th><th>Examples</th></tr>
         </thead>
         <tbody>${tableRows}</tbody>
       </table>`;

    // Display source (prefer structured list for readability)
    const srcText = (ingredientsArr && ingredientsArr.length)
      ? ingredientsArr.join(', ')
      : (rawText || '');

    const highlighted = highlightMatches(srcText, details);

    matches.innerHTML =
      `<h3>Ingredients</h3>
       <div class="ingredients-highlight">${highlighted || '<em>(no ingredients listed)</em>'}</div>
       ${table}`;
  }

  // ---------- Product Lookup (Open Food Facts) ----------
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
      renderResultDetailed(`<strong>Barcode:</strong> ${clean} — Product not found in Open Food Facts.`, [], '', []);
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

    // Raw text (keep parentheses)
    const rawText = (product.ingredients_text || '').trim();

    // Fallback to text split when array is empty
    if ((!ingredientsArr || ingredientsArr.length === 0) && rawText) {
      ingredientsArr = rawText
        .split(/[;,.\|]+/)
        .map(s => s.trim())
        .filter(Boolean);
    }

    // Detailed matches (includes contents inside parentheses)
    const details = findMatchesDetailed(ingredientsArr, rawText);

    const metaHtml = `
      <div>
        <strong>${escapeHtml(name)}</strong> ${brand ? `— ${escapeHtml(brand)}` : ''}
        <br/><small>Barcode: ${clean}</small>
      </div>
    `;

    renderResultDetailed(metaHtml, ingredientsArr, rawText, details);
  }

  lookupBtn.addEventListener('click', () => lookupBarcode(barcodeInput.value));

  // Manual check uses the same detailed renderer and parentheses expansion
  checkIngredientsBtn.addEventListener('click', () => {
    const rawText = (ingredientsText.value || '').trim();
    const arr = rawText
      .split(/[;,.\|]+/)
      .map(s => s.trim())
      .filter(Boolean);

    const details = findMatchesDetailed(arr, rawText);
    renderResultDetailed('<strong>Manual ingredients check</strong>', arr, rawText, details);
  });

  // ---------- Scanning (camera) ----------
  let mediaStream = null;
  let detector    = null;
  let scanTimer   = null;

  function setIOSPreviewAttributes(video) {
    // iOS Safari needs these for reliable inline camera preview
    video.setAttribute('playsinline', '');
    video.muted = true;
  }

  async function startScan() {
    if (hasNativeDetector) {
      return startScanNative();
    }
    return startScanZXing();
  }

  // Native BarcodeDetector path
  async function startScanNative() {
    try {
      detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'code_128'] });
    } catch (e) {
      console.error('BarcodeDetector init failed', e);
      alert('BarcodeDetector failed to initialize. Switching to ZXing fallback.');
      return startScanZXing();
    }

    try {
      if (isIOSSafari) setIOSPreviewAttributes(videoEl);

      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, // prefer rear camera, fallback gracefully
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
          // swallow transient detection errors
        }
      }, 500);

    } catch (e) {
      console.error('Camera access failed (native)', e);
      // On iOS, if live capture is blocked (permissions or policy), use photo capture fallback
      alert('Live camera access failed. Switching to photo mode—use your iPhone camera to capture a barcode.');
      return startPhotoScanFallback();
    }
  }

  // ZXing fallback (video)
  async function startScanZXing() {
    try {
      if (!window.ZXing) {
        // Auto-load ZXing UMD build
        await loadScript('https://unpkg.com/@zxing/library@latest/umd/index.min.js');
      }

      const codeReader = new ZXing.BrowserMultiFormatReader();
      const devices = await codeReader.listVideoInputDevices();

      // Prefer a rear/environment camera when available
      let deviceId = undefined;
      const back = devices.find(d => /back|rear|environment/i.test(d.label));
      deviceId = back ? back.deviceId : (devices[0] ? devices[0].deviceId : undefined);

      if (isIOSSafari) setIOSPreviewAttributes(videoEl);

      startBtn.disabled = true;
      stopBtn.disabled  = false;

      await codeReader.decodeFromVideoDevice(deviceId, videoEl, async (result, err) => {
        if (result && result.text) {
          await lookupBarcode(result.text);
          try { codeReader.reset(); } catch {}
          stopScan();
        }
      });

    } catch (e) {
      console.error('ZXing video start failed', e);
      alert('Live camera access failed. Switching to photo mode—use your iPhone camera to capture a barcode.');
      return startPhotoScanFallback();
    }
  }

  // iPhone-friendly photo-capture fallback:
  // creates a hidden file input (capture="environment"), lets user take a photo,
  // and decodes the image with ZXing.
  async function startPhotoScanFallback() {
    try {
      if (!window.ZXing) {
        await loadScript('https://unpkg.com/@zxing/library@latest/umd/index.min.js');
      }
      const codeReader = new ZXing.BrowserMultiFormatReader();

      // Create (or reuse) a hidden input
      let input = document.getElementById('__photoCaptureInput');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = '__photoCaptureInput';
        input.accept = 'image/*';
        input.capture = 'environment'; // hint to use rear camera on iPhone
        input.style.display = 'none';
        document.body.appendChild(input);
      }

      // Handler: read file -> decode
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;

        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = async () => {
          try {
            // decode from image element (preferred)
            const result = await codeReader.decodeFromImage(img);
            if (result && result.text) {
              await lookupBarcode(result.text);
              stopScan();
            } else {
              alert('Could not read the barcode from the photo. Try again with better lighting.');
            }
          } catch (err) {
            console.error('Decode from photo failed', err);
            alert('Could not read the barcode from the photo. Try again with better lighting.');
          } finally {
            URL.revokeObjectURL(url);
            input.value = ''; // reset so user can capture again
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          alert('Failed to load photo. Please try again.');
          input.value = '';
        };
        img.src = url;
      };

      // Prompt the user to take/select a photo
      input.click();

      startBtn.disabled = true;
      stopBtn.disabled  = false;

    } catch (e) {
      console.error('Photo capture fallback failed', e);
      alert('Photo capture mode failed. Please enter the barcode manually.');
      startBtn.disabled = false;
      stopBtn.disabled  = true;
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

  // Resume playback if user switches away/back (helps iOS Safari)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && videoEl && videoEl.srcObject) {
      try { await videoEl.play(); } catch {}
    }
  });

  startBtn.addEventListener('click', startScan);
  stopBtn.addEventListener('click', stopScan);

  // ---------- Optional: list media devices (debug aid) ----------
  if (navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices()
      .then(devs => devs.forEach(d => console.log(`device: ${d.kind} — ${d.label || '(no label)'} — ${d.deviceId}`)))
      .catch(e => console.warn('enumerateDevices failed:', e));
  }
})();
