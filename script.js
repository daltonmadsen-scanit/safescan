
(async function(){
  const avoid = await fetch('avoid_list.json').then(r=>r.json());
  const matchKeywords = new Set(avoid.match_keywords||[]);
  const hasBarcodeDetector = 'BarcodeDetector' in window;
  const videoEl = document.getElementById('video');
  const startBtn = document.getElementById('startScanBtn');
  const stopBtn = document.getElementById('stopScanBtn');
  const supportWarning = document.getElementById('supportWarning');
  const barcodeInput = document.getElementById('barcodeInput');
  const lookupBtn = document.getElementById('lookupBtn');
  const ingredientsText = document.getElementById('ingredientsText');
  const checkIngredientsBtn = document.getElementById('checkIngredientsBtn');
  const resultSec = document.getElementById('result');
  const productMeta = document.getElementById('productMeta');
  const matchSummary = document.getElementById('matchSummary');
  const matches = document.getElementById('matches');

  if(!hasBarcodeDetector){ supportWarning.hidden=false; }

  const norm = s => (s||'').toLowerCase().replace(/\([^\)]*\)/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();

  function findMatches(arr){
    const hits = new Set();
    for(const raw of arr){
      const t = norm(raw);
      if(!t) continue;
      for(const key of matchKeywords){ if(key && t.includes(key)) hits.add(key); }
    }
    return Array.from(hits);
  }

  function renderResult(meta, hits){
    resultSec.hidden=false; productMeta.innerHTML = meta||'';
    if(hits.length===0){ matchSummary.className='safe'; matchSummary.textContent='✅ No avoid ingredients detected.'; matches.innerHTML=''; }
    else{ matchSummary.className='unsafe'; matchSummary.textContent=`⚠️ Avoid: ${hits.length} potential matches found`; matches.innerHTML = `<h3>Matched terms</h3><ul>${hits.map(h=>`<li>${h}</li>`).join('')}</ul>`; }
  }

  async function lookupBarcode(code){
    const clean = (code||'').replace(/[^0-9]/g,'');
    if(!clean){ alert('Enter a valid numeric barcode (UPC/EAN).'); return; }
    resultSec.hidden=false; productMeta.textContent='Looking up product...'; matchSummary.textContent=''; matches.innerHTML='';

    // Open Food Facts lookup (v2 with v0 fallback)
    const urls = [
      `https://world.openfoodfacts.org/api/v2/product/${clean}?fields=product_name,brands,ingredients,ingredients_text,ingredients_tags`,
      `https://world.openfoodfacts.org/api/v0/product/${clean}.json`
    ];
    let product=null;
    for(const url of urls){
      try{
        const resp = await fetch(url, { headers: { 'User-Agent':'SafeScan-App/1.0 (westminster-co)' } });
        const data = await resp.json();
        if(data && (data.product || data.status===1)){ product = data.product || data; break; }
      }catch(e){ console.error('Lookup failed', e); }
    }
    if(!product){ renderResult(`<strong>Barcode:</strong> ${clean} — Product not found in Open Food Facts.`, []); return; }

    const name = product.product_name || product.name || '(unknown)';
    const brand = product.brands || '';
    let ingredientsArr = [];
    if(Array.isArray(product.ingredients)) ingredientsArr = product.ingredients.map(i=> i.text || i.id || i.orig || '').filter(Boolean);
    
ingredientsArr = product.ingredients_text
  .split(/[;,.\|]+/)
  .map(s => s.trim())
  .filter(Boolean);

// ===== Camera bootstrap & diagnostics =====

const previewEl = document.getElementById('preview');        
const startBtn  = document.getElementById('startCameraBtn');
const statusEl  = document.getElementById('cameraStatus');

function report(msg, err) {
  if (statusEl) statusEl.textContent = msg;
  console.log(msg, err || '');
}

if (previewEl) {
  previewEl.setAttribute('playsinline', '');
  previewEl.muted = true;
}

const constraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 }
  }
};

async function startCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      report('Camera API not available. Must be HTTPS.');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track  = stream.getVideoTracks()[0];
    previewEl.srcObject = stream;

    await new Promise(res => {
      if (previewEl.readyState >= 2) return res();
      previewEl.onloadedmetadata = res;
    });

    await previewEl.play();
    report(`Camera started: ${track ? track.label : 'Unknown device'}`);
  } catch (err) {
    switch (err.name) {
      case 'NotAllowedError':
        report('Camera denied. Check browser + OS settings.', err);
        break;
      case 'NotFoundError':
        report('No camera found or it is busy.', err);
        break;
      case 'OverconstrainedError':
        report('Requested resolution is not supported.', err);
        break;
      default:
        report(`getUserMedia error: ${err.name}`, err);
    }
  }
}

if (startBtn) startBtn.addEventListener('click', startCamera);

    const hits = findMatches(ingredientsArr);
    const metaHtml = `<div><strong>${name}</strong> ${brand ? `— ${brand}` : ''}<br/><small>Barcode: ${clean}</small></div>`;
    renderResult(metaHtml, hits);
  }

  lookupBtn.addEventListener('click', ()=> lookupBarcode(barcodeInput.value));
  checkIngredientsBtn.addEventListener('click', ()=>{ const arr = ingredientsText.value.split(/,|;|\.|
/); const hits = findMatches(arr); renderResult('<strong>Manual ingredients check</strong>', hits); });

  let mediaStream=null, detector=null, scanTimer=null;
  async function startScan(){
    if(!hasBarcodeDetector){ return startScanZXing(); }
    try{ detector = new BarcodeDetector({ formats:['ean_13','ean_8','upc_a','code_128'] }); }catch(e){ console.error('Detector init failed', e); alert('BarcodeDetector failed to initialize. Try manual entry.'); return; }
    try{
      mediaStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
      videoEl.srcObject = mediaStream; await videoEl.play(); startBtn.disabled=true; stopBtn.disabled=false;
      scanTimer = setInterval(async ()=>{
        try{
          const codes = await detector.detect(videoEl);
          if(codes && codes.length){ const raw = codes[0].rawValue || codes[0].value || ''; if(raw){ clearInterval(scanTimer); await lookupBarcode(raw); stopScan(); } }
        }catch(e){ }
      }, 500);
    }catch(e){ console.error('Camera access failed', e); alert('Camera access failed. On most browsers, scanning requires HTTPS or localhost.'); }
  }

  function stopScan(){ startBtn.disabled=false; stopBtn.disabled=true; if(scanTimer){ clearInterval(scanTimer); scanTimer=null; } if(videoEl){ videoEl.pause(); } if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; } }
  startBtn.addEventListener('click', startScan);
  stopBtn.addEventListener('click', stopScan);

  // ZXing fallback for browsers without BarcodeDetector
  async function startScanZXing(){
    if(!window.ZXing){ alert('ZXing library not available. Use manual entry.'); return; }
    const codeReader = new ZXing.BrowserMultiFormatReader();
    try {
      const devices = await codeReader.listVideoInputDevices();
      const deviceId = devices.length ? devices[0].deviceId : undefined;
      startBtn.disabled=true; stopBtn.disabled=false;
      codeReader.decodeFromVideoDevice(deviceId, 'video', async (result, err) => {
        if(result && result.text){ await lookupBarcode(result.text); stopScanZXing(codeReader); }
      });
    } catch(e){ console.error('ZXing start failed', e); alert('Camera access failed. On most browsers, scanning requires HTTPS or localhost.'); }
  }
  function stopScanZXing(reader){ try{ reader && reader.reset(); }catch(e){} startBtn.disabled=false; stopBtn.disabled=true; if(videoEl){ videoEl.pause(); }
    if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  }
})();
