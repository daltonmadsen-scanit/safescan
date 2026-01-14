
// ===== SafeScan Camera Bootstrap (2026) =====
// Works on HTTPS (e.g., GitHub Pages) with modern browsers.
// Shows the live camera preview in <video id="preview">,
// and supports an optional capture button with <button id="capture"> and <canvas id="snapshot">.

(async function safeScanCamera() {
  // --- DOM references (these elements should exist in your HTML) ---
  const videoEl = document.getElementById('preview');
  const captureBtn = document.getElementById('capture');      // optional
  const canvasEl = document.getElementById('snapshot');        // optional
  const statusEl = document.getElementById('camera-status');   // optional <div id="camera-status"></div> for messages

  // Helper: update a visible status area + console
  function setStatus(msg, isError = false) {
    console[isError ? 'error' : 'log']('[Camera]', msg);
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.style.color = isError ? '#c62828' : '#2e7d32';
    }
  }

  // Helper: user-friendly messages for common getUserMedia errors
  function explainError(err) {
    const map = {
      NotAllowedError:
        'Camera permission denied. Allow access in the browser site settings. On macOS/Windows, also check OS privacy settings for your browser.',
      NotFoundError:
        'No camera found (or constraints too strict). Try any-camera mode.',
      NotReadableError:
        'Camera is busy or blocked by another app. Close video apps (Teams/Zoom/Meet) and try again.',
      OverconstrainedError:
        'Requested constraints are not supported by this device. Using relaxed constraints.',
      SecurityError:
        'Access blocked due to page context or permissions policy.',
      AbortError:
        'The operation was aborted—try again.'
    };
    return map[err?.name] || `Unexpected error: ${err?.message || err}`;
  }

  // --- Choose constraints: prefer back camera on mobile, fall back to any camera ---
  // Start with a reasonable default; the browser will negotiate what it can.
  let constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' }, // back camera if available
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  };

  // Ensure Safari/iOS can autoplay the preview:
  // <video playsinline autoplay muted> is also needed in HTML.
  if (videoEl) {
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('autoplay', 'true');
    videoEl.muted = true; // autoplay policies often require muted
  }

  // --- Try to start the camera stream ---
  async function startStream(currentConstraints) {
    setStatus('Requesting camera access…');
    const stream = await navigator.mediaDevices.getUserMedia(currentConstraints);

    // Validate we actually got a video track
    const tracks = stream.getVideoTracks();
    if (!tracks || tracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('No video tracks were returned by the browser.');
    }

    // Attach stream and explicitly play (Safari/iOS needs this)
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {
      // Some browsers need a user gesture; if you wire a “Start” button,
      // call startCamera() from its click handler to satisfy autoplay policies.
    });

    // Show device info (label is empty until permission granted)
    const label = tracks[0].label || 'Camera active';
    setStatus(`Camera ready: ${label}`);
    return stream;
  }

  // --- Fallback: relax constraints to "any camera" if the first attempt fails ---
  async function startCamera() {
    // If Permissions API is present, this only checks site-level grants (OS-level still may block).
    try {
      if ('permissions' in navigator && navigator.permissions.query) {
        navigator.permissions.query({ name: 'camera' }).then(res => {
          // res.state can be 'granted' | 'prompt' | 'denied' (not fully standardized across browsers)
          console.log('[Camera] Permission state:', res.state);
        }).catch(() => {});
      }
    } catch (_) {}

    try {
      const stream = await startStream(constraints);
      return stream;
    } catch (err) {
      setStatus(explainError(err), true);

      // If constraint mismatch, retry with very relaxed constraints
      if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        setStatus('Retrying with relaxed constraints (any available camera)…');
        const relaxed = { audio: false, video: true };
        try {
          const stream = await startStream(relaxed);
          return stream;
        } catch (err2) {
          setStatus(explainError(err2), true);
          throw err2;
        }
      }
      throw err;
    }
  }

  // --- Optional: enumerate devices for debugging UI (after permission this will show labels) ---
  async function listDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      console.table(cams.map(d => ({ label: d.label, deviceId: d.deviceId })));
      if (cams.length === 0) {
        setStatus('No video input devices detected.', true);
      }
    } catch (e) {
      console.warn('enumerateDevices failed:', e);
    }
  }

  // --- Optional: capture still frame into <canvas id="snapshot"> when #capture is clicked ---
  function wireCapture() {
    if (!captureBtn || !canvasEl || !videoEl) return;
    captureBtn.addEventListener('click', () => {
      const { videoWidth: w, videoHeight: h } = videoEl;
      if (!w || !h) return;
      canvasEl.width = w;
      canvasEl.height = h;
      const ctx = canvasEl.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, w, h);
      setStatus('Frame captured to canvas.');
    });
  }

  // --- Kickoff ---
  if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
    setStatus(
      'Your browser does not support camera access via getUserMedia(). Try a modern browser over HTTPS.',
      true
    );
    return;
  }

  try {
    await startCamera();
    await listDevices();
    wireCapture();
  } catch (finalErr) {
    // Final guidance to user/dev
    alert(
      'Camera failed to start.\n\n' +
      explainError(finalErr) +
      '\n\nTroubleshooting:\n' +
      '• Ensure you are on HTTPS and using a supported browser.\n' +
      '• Allow camera permission in the browser (Site settings).\n' +
      '• Check OS privacy settings for your browser (macOS/Windows).\n' +
      '• Close other apps using the camera (Teams/Zoom/Meet).\n'
    );
  }
})();
