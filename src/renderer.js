const statusBadge = document.getElementById('statusBadge');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const errorMsg = document.getElementById('errorMsg');
const lastUpdate = document.getElementById('lastUpdate');

const startBtn = document.getElementById('startBtn');
const startDot = document.getElementById('startDot');
const stopBtn = document.getElementById('stopBtn');

const qtyInput = document.getElementById('qtyInput');
const qtySetBtn = document.getElementById('qtySetBtn');

const fillOneBtn = document.getElementById('fillOneBtn');
const fillTwoBtn = document.getElementById('fillTwoBtn');
const fillBothBtn = document.getElementById('fillBothBtn');
const fillDirValue = document.getElementById('fillDirValue');

const refillPulseBtn = document.getElementById('refillPulseBtn');
const fill1Toggle = document.getElementById('fill1Toggle');
const fill2Toggle = document.getElementById('fill2Toggle');

const stockValue = document.getElementById('stockValue');
const fill1Value = document.getElementById('fill1Value');
const fill2Value = document.getElementById('fill2Value');
const rfidValue = document.getElementById('rfidValue');
const statusValue = document.getElementById('statusValue');

const m57Indicator = document.getElementById('m57Indicator');
const captureLog = document.getElementById('captureLog');
const lastCaptureImg = document.getElementById('lastCaptureImg');
const cameraVideo = document.getElementById('cameraVideo');
const captureCanvas = document.getElementById('captureCanvas');

const goodCountEl = document.getElementById('goodCount');
const badCountEl = document.getElementById('badCount');
const unknownCountEl = document.getElementById('unknownCount');
const resetCountsBtn = document.getElementById('resetCountsBtn');
const lastFillStatus = document.getElementById('lastFillStatus');
const lastFillConfidence = document.getElementById('lastFillConfidence');
const lastClassification = document.getElementById('lastClassification');
const lastRedBalls = document.getElementById('lastRedBalls');
const lastBlueBalls = document.getElementById('lastBlueBalls');

let captureCount = 0;
let cameraReady = false;

let isConnected = false;

// Local cache for the write-only bits (M153/154/155) so the toggle reflects
// what we last commanded, since these are write-only on the PLC side.
const bitState = { fill1: false, fill2: false };

function getConfig() {
  return {
    ip: document.getElementById('ip').value.trim(),
    port: document.getElementById('port').value,
    slaveId: document.getElementById('slaveId').value,
    interval: document.getElementById('interval').value,
  };
}

function showError(message) {
  errorMsg.textContent = message || '';
}

function setConnectedUI(connected) {
  isConnected = connected;
  statusBadge.textContent = connected ? 'Connected' : 'Disconnected';
  statusBadge.className = `status ${connected ? 'connected' : 'disconnected'}`;
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;

  [startBtn, stopBtn, qtySetBtn, fillOneBtn, fillTwoBtn, fillBothBtn, oeeOpenBtn, refillPulseBtn].forEach((btn) => {
    btn.disabled = !connected;
  });
  [fill1Toggle, fill2Toggle].forEach((toggle) => {
    toggle.disabled = !connected;
  });

  if (!connected) {
    startDot.classList.remove('blinking');
  }
}

// ---------------------------------------------------------------------------
// Connect / Disconnect
// ---------------------------------------------------------------------------
connectBtn.addEventListener('click', async () => {
  showError('');
  const config = getConfig();
  const result = await window.plcAPI.connect(config);
  if (result.ok) {
    setConnectedUI(true);
    await window.plcAPI.startPolling(config);
  } else {
    showError(`Connection failed: ${result.error}`);
    setConnectedUI(false);
  }
});

disconnectBtn.addEventListener('click', async () => {
  await window.plcAPI.stopPolling();
  await window.plcAPI.disconnect();
  setConnectedUI(false);
});

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------
startBtn.addEventListener('click', async () => {
  showError('');
  const result = await window.plcAPI.start();
  if (!result.ok) showError(`Start failed: ${result.error}`);
});

stopBtn.addEventListener('click', async () => {
  showError('');
  stopBtn.disabled = true;
  const result = await window.plcAPI.stop();
  stopBtn.disabled = !isConnected;
  if (!result.ok) showError(`Stop failed: ${result.error}`);
});

// ---------------------------------------------------------------------------
// Quantity (D0), range 1-5
// ---------------------------------------------------------------------------
qtySetBtn.addEventListener('click', async () => {
  showError('');
  const value = Number(qtyInput.value);
  const result = await window.plcAPI.setQuantity(value);
  if (!result.ok) showError(`Set quantity failed: ${result.error}`);
});

// ---------------------------------------------------------------------------
// Filling direction (D2): One = -1, Two = +1
// ---------------------------------------------------------------------------
fillOneBtn.addEventListener('click', async () => {
  showError('');
  const result = await window.plcAPI.setFillingDirection('one');
  if (!result.ok) showError(`Filling One failed: ${result.error}`);
});

fillTwoBtn.addEventListener('click', async () => {
  showError('');
  const result = await window.plcAPI.setFillingDirection('two');
  if (!result.ok) showError(`Filling Two failed: ${result.error}`);
});

fillBothBtn.addEventListener('click', async () => {
  showError('');
  const result = await window.plcAPI.setFillingDirection('both');
  if (!result.ok) showError(`Filling Both failed: ${result.error}`);
});

// ---------------------------------------------------------------------------
// Bit controls
// ---------------------------------------------------------------------------

// Stock Refill (M153) is momentary — click pulses it HIGH briefly then
// back LOW, same pattern as Stop/Reset, instead of a persistent toggle.
refillPulseBtn.addEventListener('click', async () => {
  showError('');
  refillPulseBtn.disabled = true;
  try {
    let result = await window.plcAPI.writeBit('refill', 1);
    if (!result.ok) {
      showError(`Stock Refill pulse failed: ${result.error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await window.plcAPI.writeBit('refill', 0);
    if (!result.ok) {
      showError(`Stock Refill release failed: ${result.error}`);
    }
  } finally {
    refillPulseBtn.disabled = !isConnected;
  }
});

// Filling One (M154) / Filling Two (M155) — write-only 0/1, still toggles.
function bindBitToggle(toggleEl, target) {
  toggleEl.addEventListener('change', async () => {
    showError('');
    const value = toggleEl.checked ? 1 : 0;
    const result = await window.plcAPI.writeBit(target, value);
    if (!result.ok) {
      showError(`Write ${target} failed: ${result.error}`);
      toggleEl.checked = !toggleEl.checked; // revert on failure
      return;
    }
    bitState[target] = !!value;
  });
}

bindBitToggle(fill1Toggle, 'fill1');
bindBitToggle(fill2Toggle, 'fill2');

// ---------------------------------------------------------------------------
// Camera: request the webcam once at startup, keep the <video> element fed.
// ---------------------------------------------------------------------------
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraVideo.srcObject = stream;
    await new Promise((resolve) => {
      cameraVideo.onloadedmetadata = resolve;
    });
    cameraReady = true;
    captureLog.textContent = 'Camera ready. Waiting for M57 trigger...';
  } catch (err) {
    cameraReady = false;
    captureLog.textContent = `Camera failed to start: ${err.message}`;
    showError(`Camera unavailable: ${err.message}`);
  }
}

async function captureImage() {
  if (!cameraReady || !cameraVideo.videoWidth) {
    captureLog.textContent = 'M57 triggered, but camera was not ready — no image captured.';
    showError('Camera not ready — cannot capture image.');
    return;
  }
  captureCanvas.width = cameraVideo.videoWidth;
  captureCanvas.height = cameraVideo.videoHeight;
  const ctx = captureCanvas.getContext('2d');
  ctx.drawImage(cameraVideo, 0, 0, captureCanvas.width, captureCanvas.height);
  const dataUrl = captureCanvas.toDataURL('image/png');

  const result = await window.plcAPI.saveImage(dataUrl);
  captureCount += 1;

  lastCaptureImg.src = dataUrl;
  lastCaptureImg.classList.add('visible');

  if (result.ok) {
    lastFillStatus.textContent = result.fillStatus || '--';
    lastFillConfidence.textContent = result.confidence != null ? `(${result.confidence}% coloured)` : '';
    lastClassification.textContent = result.classification || '--';
    lastRedBalls.textContent = result.redBalls ?? '--';
    lastBlueBalls.textContent = result.blueBalls ?? '--';

    if (result.counts) {
      goodCountEl.textContent = result.counts.good;
      badCountEl.textContent = result.counts.bad;
      unknownCountEl.textContent = result.counts.unknown;
    }

    // Analysis errors/notes go in captureLog, NOT the shared error banner —
    // the dashboard poll clears that banner every ~800ms, so a real error
    // here would flash and disappear before it could ever be read.
    if (result.analysisError) {
      captureLog.textContent = `Capture #${captureCount} saved, but analysis FAILED: ${result.analysisError}`;
    } else if (result.analysisNote) {
      captureLog.textContent = `Capture #${captureCount} saved: ${result.path} — Note: ${result.analysisNote}`;
    } else {
      captureLog.textContent = `Capture #${captureCount} saved: ${result.path}`;
    }
  } else {
    captureLog.textContent = `Capture #${captureCount} taken, but save failed: ${result.error}`;
  }
}

resetCountsBtn.addEventListener('click', async () => {
  const result = await window.plcAPI.resetCounts();
  if (result.ok) {
    goodCountEl.textContent = result.counts.good;
    badCountEl.textContent = result.counts.bad;
    unknownCountEl.textContent = result.counts.unknown;
  }
});

initCamera();

// Fast, dedicated M57 trigger channel — separate from the dashboard poll,
// so short pulses aren't missed while waiting on the other 9 register reads.
window.plcAPI.onCameraTrigger((data) => {
  m57Indicator.textContent = data.high ? 'HIGH' : 'LOW';
  m57Indicator.className = `pill ${data.high ? 'on' : 'off'}`;

  if (data.fireCapture) {
    captureImage();
  }
});

// ---------------------------------------------------------------------------
// Live data from polling
// ---------------------------------------------------------------------------
window.plcAPI.onData((result) => {
  if (!result.ok) {
    showError(`Error: ${result.error}`);
    return;
  }
  showError('');

  startDot.classList.toggle('blinking', result.running);
  stockValue.textContent = result.containerStock ?? '--';
  fill1Value.textContent = result.fillingOneLevel ?? '--';
  fill2Value.textContent = result.fillingTwoLevel ?? '--';
  rfidValue.textContent = result.rfidTag || '--';
  statusValue.textContent = result.statusText || '--';
  fillDirValue.textContent = result.fillDirection ?? '--';

  lastUpdate.textContent = `Last update: ${new Date(result.timestamp).toLocaleTimeString()}`;
});

// ---------------------------------------------------------------------------
// OEE Dashboard
// ---------------------------------------------------------------------------
const oeeOpenBtn = document.getElementById('oeeOpenBtn');
const oeeCloseBtn = document.getElementById('oeeCloseBtn');
const oeeOverlay = document.getElementById('oeeOverlay');
const oeeResetBtn = document.getElementById('oeeResetBtn');
const oeeErrorEl = document.getElementById('oeeError');

const gaugeAvailability = document.getElementById('gaugeAvailability');
const gaugePerformance = document.getElementById('gaugePerformance');
const gaugeQuality = document.getElementById('gaugeQuality');
const gaugeOEE = document.getElementById('gaugeOEE');

const availabilityValueEl = document.getElementById('availabilityValue');
const performanceValueEl = document.getElementById('performanceValue');
const qualityValueEl = document.getElementById('qualityValue');
const oeeValueEl = document.getElementById('oeeValue');
const idealRunTimeValueEl = document.getElementById('idealRunTimeValue');
const actualRunTimeValueEl = document.getElementById('actualRunTimeValue');
const performanceLossValueEl = document.getElementById('performanceLossValue');
const downTimeValueEl = document.getElementById('downTimeValue');

let oeePollTimer = null;

// Draws a ~180-degree "rainbow" gauge arc (matches the mockup's gauge
// style) as plain SVG — no charting library needed for something this
// simple. percent is clamped to 0-100 for the arc even if the PLC sends a
// value outside that range (the numeric readout below it still shows the
// raw value).
function polarPoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarPoint(cx, cy, r, startAngle);
  const end = polarPoint(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function renderGauge(svgEl, percent, color) {
  const cx = 100;
  const cy = 120;
  const r = 80;
  const strokeWidth = 18;
  const startAngle = -180;
  const endAngle = 0;
  const clamped = Math.max(0, Math.min(100, percent || 0));
  const valueAngle = startAngle + (clamped / 100) * (endAngle - startAngle);

  const track = describeArc(cx, cy, r, startAngle, endAngle);
  const valueArc = clamped > 0 ? describeArc(cx, cy, r, startAngle, valueAngle) : '';

  svgEl.innerHTML = `
    <path d="${track}" fill="none" stroke="#e8ecfa" stroke-width="${strokeWidth}" stroke-linecap="round" />
    ${valueArc ? `<path d="${valueArc}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />` : ''}
  `;
}

function showOeeError(message) {
  oeeErrorEl.textContent = message || '';
}

async function refreshOEE() {
  const result = await window.plcAPI.readOEE();
  if (!result.ok) {
    showOeeError(`Error: ${result.error}`);
    return;
  }
  showOeeError('');

  renderGauge(gaugeAvailability, result.availability, '#c0392b');
  renderGauge(gaugePerformance, result.performance, '#e1ac3d');
  renderGauge(gaugeQuality, result.quality, '#173681');
  renderGauge(gaugeOEE, result.oee, '#173681');

  availabilityValueEl.textContent = result.availability;
  performanceValueEl.textContent = result.performance;
  qualityValueEl.textContent = result.quality;
  oeeValueEl.textContent = result.oee;
  idealRunTimeValueEl.textContent = result.idealRunTime;
  actualRunTimeValueEl.textContent = result.actualRunTime;
  performanceLossValueEl.textContent = result.performanceLoss;
  downTimeValueEl.textContent = result.downTime;
}

function openOeeModal() {
  oeeOverlay.style.display = 'flex';
  refreshOEE();
  oeePollTimer = setInterval(refreshOEE, 1500);
}

function closeOeeModal() {
  oeeOverlay.style.display = 'none';
  if (oeePollTimer) {
    clearInterval(oeePollTimer);
    oeePollTimer = null;
  }
}

oeeOpenBtn.addEventListener('click', openOeeModal);
oeeCloseBtn.addEventListener('click', closeOeeModal);
oeeOverlay.addEventListener('click', (e) => {
  if (e.target === oeeOverlay) closeOeeModal();
});

oeeResetBtn.addEventListener('click', async () => {
  showOeeError('');
  const result = await window.plcAPI.resetOEE();
  if (!result.ok) {
    showOeeError(`Reset failed: ${result.error}`);
    return;
  }
  refreshOEE();
});