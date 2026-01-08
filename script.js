
/* SafeScan - script.js (Synonym expansion + Level 2/3 only + iPhone-ready)
   - Uses existing DOM IDs (no HTML changes)
   - Synonym expansion: parentheses & composite labels split into separate entries (no roll-ups)
   - Only warns for Level >= 2 (2 or 3)
   - iOS Safari: playsinline + muted; photo-capture fallback if live video fails
   - BarcodeDetector (native) with ZXing fallback (video & photo)
   - Open Food Facts lookup (v2 + v0 fallback)
   - Detailed ingredient matching & highlighting
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

  // ---------- Env ----------
  const ua = navigator.userAgent || '';
  const isIOS       = /iPhone|iPad|iPod/i.test(ua);
  const isSafari    = (!!navigator.vendor && navigator.vendor.includes('Apple')) || /Safari/i.test(ua);
  const isIOSSafari = isIOS && isSafari;

  // ---------- Avoid list loader ----------
  async function loadAvoidList() {
    // Prefer the Level 2/3 file if present; else fall back to the original
    try {
      const r = await fetch('avoid_list_level2_3.json');
      if (r.ok) return r.json();
    } catch (e) {}
    const r2 = await fetch('avoid_list.json');
    return r2.json();
  }

  const avoidJson = await loadAvoidList();

  // ---------- Synonym expansion & Level filter (>=2) ----------
  const AVOID_LEVEL_MIN = 2;

  const clean = s => (s || '').trim();
  const isBlank = s => !s || !s.trim();

  /** Split a composite label (commas, semicolons, pipes, slashes, ampersands, words "and") into parts. */
  function splitComposite(label) {
    return clean(label)
      .split(/\s*(?:[,;|\/&]|(?:\band\b))\s*/i)
      .map(t => t.trim())
      .filter(Boolean);
  }

  /** Extract sub‑parts from parentheses: "Cheese (havarti, brie)" -> ["havarti","brie"] */
  function extractParenParts(label) {
    const m = /\(([^)]*)\)/.exec(label);
    if (!m || !m[1]) return [];
    return splitComposite(m[1]);
  }

  /** Normalize the incoming avoid list to [{term, level, category, group}] */
  function normalizeAvoidList(avoidJson) {
    if (Array.isArray(avoidJson?.avoid_terms)) {
      return avoidJson.avoid_terms.map(x => ({
        term: clean(x.term),
        level: Number(x.level) || 1,
        category: clean(x.category),
        group: clean(x.group)
      }));
    }
    if (Array.isArray(avoidJson?.match_keywords)) {
      // Legacy format: treat as Level 1 unless you later override in a custom file
      return avoidJson.match_keywords.map(t => ({
        term: clean(t),
        level: 1,
        category: '',
        group: ''
      }));
    }
    return [];
  }

  /**
   * Expand synonyms:
   * - Keep the original label as an entry.
   * - Add each parenthetical part as its own entry.
   * - If the original label is composite ("A, B"), add each component as its own entry.
   * - Filter to Level >= 2 only.
   * - No roll-ups (every synonym remains separate).
   * - De-duplicate identical entries (term+level+category+group).
   */
  function expandAvoidList(avoidJson) {
    const base = normalizeAvoidList(avoidJson);
    const expanded = [];

    for (const row of base) {
      if (isBlank(row.term)) continue;
      const level = Number(row.level) || 1;
      const category = clean(row.category);
      const group = clean(row.group);

      if (level < AVOID_LEVEL_MIN) continue;

      // 1) Keep the original label
      expanded.push({ term: row.term, level, category, group });

      // 2) Parentheses parts (e.g., Cheese (havarti) => havarti)
      const subparts = extractParenParts(row.term);
      for (const p of subparts) {
        expanded.push({ term: p, level, category, group });
      }

      // 3) Composite original label split (e.g., "Locust Bean Gum, Carob Gum")
      const comps = splitComposite(row.term);
      // If composite produced 2+ parts, add each as its own entry (unique synonyms)
      if (comps.length > 1) {
        for (const c of comps) {
          // Skip adding the identical full label again
          if (c.toLowerCase() !== row.term.toLowerCase()) {
            expanded.push({ term: c, level, category, group });
          }
        }
      }
    }

    // De-dup identical entries
    const seen = new Set();
    const deduped = [];
    for (const e of expanded) {
      const key = `${e.term.toLowerCase()}|${e.level}|${(e.category || '').toLowerCase()}|${(e.group || '').toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(e);
      }
    }

    // Sort for deterministic output: level desc, category, term
    deduped.sort((a, b) =>
      (b.level - a.level) ||
      (a.category || '').localeCompare(b.category || '') ||
      a.term.localeCompare(b.term)
    );

    return deduped;
  }

  const avoidTermsExpanded = expandAvoidList(avoidJson);

  /** Build a token index: token (lowercased term) -> array of avoid entries that use that exact token.
   * We match **exactly** what each entry says (no roll-up, no grouping).
   */
  function buildTokenIndex(entries) {
    const tokenIndex = new Map();
    for (const e of entries) {
      const token = e.term.toLowerCase();
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(e);
    }
    return tokenIndex;
  }

  const tokenIndex = buildTokenIndex(avoidTermsExpanded);

  // ---------- Ingredient normalization (for text display and matching) ----------
  // Keep parentheses in ingredients; split for display when no structured list is present.
  function expandCompoundIngredients(arr) {
    const out = [];
    for (const raw of (arr || [])) {
      if (!raw) continue;
      out.push(raw); // keep original chunk for display
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

  // ---------- Rendering helpers ----------
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  /**
   * Match using the token index; keep each synonym separate in results.
   * Returns: [{ term, level, category, hits, positions, examples }]
   */
  function matchAvoidTerms(text, tokenIndex) {
    const details = [];
    const seen = new Set();
    const src = text || '';
    for (const [token, entries] of tokenIndex.entries()) {
      const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let m;
      let hits = 0;
      const positions = [];
      const examples = [];
      while ((m = re.exec(src)) !== null) {
        hits++;
        positions.push([m.index, m.index + token.length]);
        examples.push(src.slice(m.index, m.index + token.length));
      }
      if (hits > 0) {
        for (const e of entries) {
          const key = `${e.term}|${token}`;
          if (seen.has(key)) continue;
          seen.add(key);
          details.push({
            term: e.term,
            level: e.level,
            category: e.category,
            hits,
            positions,
            examples
          });
        }
      }
    }
    // Sort: higher level first, then hits then term
    details.sort((a, b) =>
      (b.level - a.level) || (b.hits - a.hits) || a.term.localeCompare(b.term)
    );
    return details;
  }

  function highlightMatches(text, details) {
    if (!text) return '';
    if (!details || details.length === 0) return escapeHtml(text);

    const ranges = [];
    for (const d of details) {
      for (const [start, end] of d.positions) {
        ranges.push({ start, end, term: d.term, level: d.level });
      }
    }
    ranges.sort((a, b) => a.start - b.start);

    // Merge overlaps, keep highest level for style
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
        last.level = Math.max(last.level, r.level);
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
      const levelClass = r.level >= 3 ? 'mark-high' : 'mark-mid';
      html += `<mark class="${levelClass}" title="Matched (L${r.level}): ${escapeHtml(r.term)}">${escapeHtml(segment)}</mark>`;
      cursor = r.end;
    }
    if (cursor < text.length) {
      html += escapeHtml(text.slice(cursor));
    }
    return html;
  }

  function renderResultDetailed(meta, ingredientsArr, rawText, details) {
    resultSec.hidden = false;
    productMeta.innerHTML = meta || '';

    const totalHits = details.reduce((sum, d) => sum + d.hits, 0);
    if (details.length === 0) {
      matchSummary.className = 'safe';
      matchSummary.textContent = '✅ No level 2–3 sensitivities detected.';
      matches.innerHTML = '';
      return;
    }

    const levelCounts = details.reduce((acc, d) => {
      acc[d.level] = (acc[d.level] || 0) + d.hits;
      return acc;
    }, {});

    matchSummary.className = 'unsafe';
    matchSummary.textContent =
      `⚠️ Sensitivity warnings (L2–L3): ${details.length} terms • ${totalHits} occurrences` +
      (levelCounts[3] ? ` • L3: ${levelCounts[3]}` : '') +
      (levelCounts[2] ? ` • L2: ${levelCounts[2]}` : '');

    const tableRows = details.map(d =>
      `<tr>
         <td>${escapeHtml(d.term)}</td>
         <td style="text-align:center">L${d.level}</td>
         <td style="text-align:center">${d.hits}</td>
         <td><span class="category-chip">${escapeHtml(d.category || '')}</span></td>
         <td>${d.examples.slice(0, 6).map(x => `<code>${escapeHtml(x)}</code>`).join(', ')}${d.examples.length > 6 ? ' …' : ''}</td>
       </tr>`
    ).join('');

    const table =
      `<h3>Matched Terms (Level 2–3)</h3>
       <table class="matches-table">
         <thead>
           <tr><th>Term</th><th>Level</th><th>Hits</th><th>Category</th><th>Examples</th></tr>
         </thead>
         <tbody>${tableRows}</tbody>
       </table>`;

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
    const cleanCode = (code || '').replace(/[^0-9]/g, '');
    if (!cleanCode) {
      alert('Enter a valid numeric barcode (UPC/EAN).');
      return;
    }

    resultSec.hidden = false;
    productMeta.textContent = 'Looking up product...';
    matchSummary.textContent = '';
    matches.innerHTML = '';

    const urls = [
      `https://world.openfoodfacts.org/api/v2/product/${cleanCode}?fields=product_name,brands,ingredients,ingredients_text,ingredients_tags`,
      `https://world.openfoodfacts.org/api/v0/product/${cleanCode}.json`
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
      renderResultDetailed(`<strong>Barcode:</strong> ${cleanCode} — Product not found in Open Food Facts.`, [], '', []);
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

    // Build display + matching source text
    const srcText = (ingredientsArr && ingredientsArr.length)
      ? ingredientsArr.join(', ')
      : rawText;

    // Match against tokenIndex (each synonym is separate)
    const details = matchAvoidTerms(srcText, tokenIndex);

    const metaHtml = `
      <div>
        <strong>${escapeHtml(name)}</strong> ${brand ? `— ${escapeHtml(brand)}` : ''}
        <br/><small>Barcode: ${cleanCode}</small>
      </div>
    `;

    renderResultDetailed(metaHtml, ingredientsArr, rawText, details);
  }

  lookupBtn.addEventListener('click', () => lookupBarcode(barcodeInput.value));

  // Manual check → same pipeline
  checkIngredientsBtn.addEventListener('click', () => {
    const rawText = (ingredientsText.value || '').trim();
    const arr = rawText
      .split(/[;,.\|]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const srcText = (arr && arr.length) ? arr.join(', ') : rawText;

    const details = matchAvoidTerms(srcText, tokenIndex);
    renderResultDetailed('<strong>Manual ingredients check</strong>', arr, rawText, details);
  });

  // ---------- Scanning (camera) ----------
  let mediaStream = null;
  let detector    = null;
  let scanTimer   = null;

  function setIOSPreviewAttributes(video) {
    // iOS Safari inline camera preview tweaks
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

  async function startScan() {
    if ('BarcodeDetector' in window) {
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
      if (isIOSSafari) setIOSPreviewAttributes(videoEl);

      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });

      videoEl.srcObject = mediaStream;

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
        } catch {}
      }, 500);

    } catch (e) {
      console.error('Camera access failed (native)', e);
      alert('Live camera access failed. Switching to photo mode—use your iPhone camera to capture a barcode.');
      return startPhotoScanFallback();
    }
  }

  async function startScanZXing() {
    try {
      if (!window.ZXing) {
        await loadScript('https://unpkg.com/@zxing/library@latest/umd/index.min.js');
      }

      const codeReader = new ZXing.BrowserMultiFormatReader();
      const devices = await codeReader.listVideoInputDevices();

      // Prefer rear camera
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

  async function startPhotoScanFallback() {
    try {
      if (!window.ZXing) {
        await loadScript('https://unpkg.com/@zxing/library@latest/umd/index.min.js');
      }
      const codeReader = new ZXing.BrowserMultiFormatReader();

      let input = document.getElementById('__photoCaptureInput');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file';
        input.id = '__photoCaptureInput';
        input.accept = 'image/*';
        input.capture = 'environment';
        input.style.display = 'none';
        document.body.appendChild(input);
      }

      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;

        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = async () => {
          try {
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
            input.value = '';
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          alert('Failed to load photo. Please try again.');
          input.value = '';
        };
        img.src = url;
      };

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

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && videoEl && videoEl.srcObject) {
      try { await videoEl.play(); } catch {}
    }
  });

  startBtn.addEventListener('click', startScan);
  stopBtn.addEventListener('click', stopScan);

  // ---------- Optional: list media devices (debug) ----------
  if (navigator.mediaDevices?.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices()
