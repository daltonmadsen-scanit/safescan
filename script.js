
// ===== SafeScan Mobile Camera (iOS + Android) =====
// Works on GitHub Pages (HTTPS). Handles iOS Safari quirks (user gesture,
// playsinline/autoplay/muted) and Android browsers (Chrome/Edge/Firefox).

(() => {
  const els = {
    video:   document.getElementById('preview'),
    status:  document.getElementById('camera-status'),
    start:   document.getElementById('start'),
    flip:    document.getElementById('flip'),
    capture: document.getElementById('capture'),
    stop:    document.getElementById('stop'),
    canvas:  document.getElementById('snapshot'),
  };

  let currentStream = null;
  let usingDeviceId = null;     // active camera deviceId
  let facing = 'environment';   // 'user' or 'environment'

  // Secure context check (HTTPS or localhost)
  const isSecure =
    location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';

  function setStatus(msg, isError = false) {
    console.log('[Camera]', msg);
    if (els.status) {
      els.status.textContent = msg;
      els.status.style.color = isError ? '#c62828' : '#8be28b';
    }
  }

  function explainError(err) {
    const map = {
      NotAllowedError:
        'Permission denied. Allow camera in browser site settings; also check OS privacy settings for this browser.',
      NotFoundError:
        'No camera found or constraints too strict. Retrying with any available camera…',
      NotReadableError:
        'Camera busy or blocked by another app. Close Teams/Zoom/Meet and try again.',
      OverconstrainedError:
        'Requested constraints unsupported on this device. Using relaxed constraints.',
      SecurityError:
        'Access blocked due to context or permissions policy.',
      AbortError:
        'Camera start aborted—try again.',
    };
    return map[err?.name] || `Unexpected error: ${err?.message || err}`;
  }

  function enableControls(started) {
    els.start.disabled   = started;
    els.flip.disabled    = !started;
    els.capture.disabled = !started;
    els.stop.disabled    = !started;
  }

  // Make sure iOS inline playback is allowed
  if (els.video) {
    els.video.setAttribute('playsinline', 'true');
    els.video.setAttribute('autoplay', 'true');
    els.video.muted = true;
  }

  async function getVideoInputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'videoinput');
    } catch (e) {
      console.warn('enumerateDevices failed:', e);
      return [];
    }
  }

  async function openStream(preferredFacing = 'environment', deviceId = null) {
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId } }, audio: false }
      : { video: { facingMode: { ideal: preferredFacing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

    setStatus('Requesting camera…');

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      ensureTracks(stream);
      await attachStream(stream);
      return stream;
    } catch (err) {
      setStatus(explainError(err), true);

      // Relax constraints: try "any camera"
      if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') {
        try {
          const relaxed = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          ensureTracks(relaxed);
          await attachStream(relaxed);
          return relaxed;
        } catch (err2) {
          setStatus(explainError(err2), true);
          throw err2;
        }
      }
      throw err;
    }
  }

  function ensureTracks(stream) {
    const tracks = stream.getVideoTracks();
    if (!tracks || tracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('No video tracks returned by browser.');
    }
  }

  async function attachStream(stream) {
    // Stop previous stream if any
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }
    currentStream = stream;

    const track  = stream.getVideoTracks()[0];
    const info   = track.getSettings?.() || {};
    usingDeviceId = info.deviceId || null;

    const label = track.label || 'Camera';
    setStatus(`Camera ready: ${label}`);

    els.video.srcObject = stream;

    // Safari/iOS often needs explicit play() after a user gesture
    try {
      await els.video.play();
    } catch {
      // If autoplay blocked, "Start Camera" button click will satisfy the gesture
    }

    enableControls(true);
  }

  function stopStream() {
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
      // Toggle facing; browser will choose if only one camera exists
      facing = (facing === 'environment') ? 'user' : 'environment';
      await startCamera();
      return;
    }

    // Pick a different deviceId than the current one
    const alt = inputs.find(d => d.deviceId !== usingDeviceId) || inputs[0];
    facing = (facing === 'environment') ? 'user' : 'environment';
    await startCamera(alt.deviceId);
  }

  function captureFrame() {
    if (!currentStream) return;
    const { videoWidth: w, videoHeight: h } = els.video;
    if (!w || !h) return;
    els.canvas.width = w;
    els.canvas.height = h;
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

    try {
      await openStream(facing, forceDeviceId);
      // Log devices after permission (labels now visible)
      getVideoInputs().then(cams =>
        console.table(cams.map(d => ({ label: d.label, deviceId: d.deviceId })))
      );
    } catch (err) {
      alert(
        'Camera failed to start.\n\n' +
        explainError(err) +
        '\n\nTroubleshooting:\n' +
        '• Allow camera permission in browser site settings.\n' +
        '• Check OS privacy settings for your browser.\n' +
        '• Close other apps using the camera (Teams/Zoom/Meet).\n'
      );
    }
  }

  // Wire UI (user gestures satisfy iOS autoplay policy)
  els.start?.addEventListener('click', () => startCamera());
  els.flip?.addEventListener('click', () => flipCamera());
  els.capture?.addEventListener('click', () => captureFrame());
  els.stop?.addEventListener('click', () => stopStream());

  // Optional auto-start on load; if blocked (iOS), user taps "Start Camera"
  document.addEventListener('DOMContentLoaded', async () => {
    try { await startCamera(); } catch { /* gesture will be required */ }
  });
})();
