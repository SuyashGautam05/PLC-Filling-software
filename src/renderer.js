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
const fill1PulseBtn = document.getElementById('fill1PulseBtn');
const fill2PulseBtn = document.getElementById('fill2PulseBtn');

const stockValue = document.getElementById('stockValue');
const fill1Value = document.getElementById('fill1Value');
const fill2Value = document.getElementById('fill2Value');
const rfidValue = document.getElementById('rfidValue');
const statusValue = document.getElementById('statusValue');

const m57Indicator = document.getElementById('m57Indicator');
const captureLog = document.getElementById('captureLog');
const resultBanner = document.getElementById('resultBanner');
const lastCaptureImg = document.getElementById('lastCaptureImg');
const cameraVideo = document.getElementById('cameraVideo');
const captureCanvas = document.getElementById('captureCanvas');

const passCountEl = document.getElementById('passCount');
const rejectCountEl = document.getElementById('rejectCount');
const unknownCountEl = document.getElementById('unknownCount');
const resetCountsBtn = document.getElementById('resetCountsBtn');
const lastFillStatus = document.getElementById('lastFillStatus');
const lastFillConfidence = document.getElementById('lastFillConfidence');
const lastClassification = document.getElementById('lastClassification');
const lastRedBalls = document.getElementById('lastRedBalls');
const lastBlueBalls = document.getElementById('lastBlueBalls');

// Section navigation
const navProductSelection = document.getElementById('navProductSelection');
const navOeeDashboard = document.getElementById('navOeeDashboard');
const navInventory = document.getElementById('navInventory');
const navProductionReports = document.getElementById('navProductionReports');
const productSelectionOverlay = document.getElementById('productSelectionOverlay');
const productSelectionCloseBtn = document.getElementById('productSelectionCloseBtn');
const inventoryOverlay = document.getElementById('inventoryOverlay');
const inventoryCloseBtn = document.getElementById('inventoryCloseBtn');
const reportsOverlay = document.getElementById('reportsOverlay');
const reportsCloseBtn = document.getElementById('reportsCloseBtn');

// Production Reports
const reportEntryCount = document.getElementById('reportEntryCount');
const downloadReportBtn = document.getElementById('downloadReportBtn');
const reportError = document.getElementById('reportError');

let captureCount = 0;
let cameraReady = false;

let isConnected = false;

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

  [
    startBtn, stopBtn, qtySetBtn, fillOneBtn, fillTwoBtn, fillBothBtn,
    refillPulseBtn, fill1PulseBtn, fill2PulseBtn,
    navProductSelection, navOeeDashboard, navInventory, navProductionReports,
  ].forEach((btn) => {
    btn.disabled = !connected;
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
let currentQuantity = 1; // tracked so the buckets know how many balls to draw

qtySetBtn.addEventListener('click', async () => {
  showError('');
  const value = Number(qtyInput.value);
  const result = await window.plcAPI.setQuantity(value);
  if (!result.ok) {
    showError(`Set quantity failed: ${result.error}`);
    return;
  }
  currentQuantity = value; // optimistic — confirmed by the next poll's result.quantity
  updateFillBuckets(currentFillDirection);
});

// ---------------------------------------------------------------------------
// Filling direction (D2): One = -1, Two = +1
// ---------------------------------------------------------------------------
const bucketOneBalls = document.getElementById('bucketOneBalls');
const bucketTwoBalls = document.getElementById('bucketTwoBalls');
const bucketBothBalls = document.getElementById('bucketBothBalls');

let currentFillDirection = null;

// Fills a bucket with actual ball elements — one per unit of the current
// Quantity (D0), not a solid liquid fill. `colors` is an array the same
// length as the ball count is allowed to cycle through, e.g. ['red'] for
// a single-color bucket or ['red','blue'] to alternate for "Both".
function renderBalls(container, count, colors) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const ball = document.createElement('div');
    ball.className = `ball ${colors[i % colors.length]}`;
    container.appendChild(ball);
  }
}

// Shows exactly ONE ball in the active bucket (not scaled by Quantity) —
// red for Filling One, blue for Filling Two, a single red/blue bicolor
// ball for Filling Both. Inactive buckets stay empty.
function updateFillBuckets(d2Value) {
  currentFillDirection = d2Value;
  renderBalls(bucketOneBalls, d2Value === -1 ? 1 : 0, ['red']);
  renderBalls(bucketTwoBalls, d2Value === 1 ? 1 : 0, ['blue']);
  renderBalls(bucketBothBalls, d2Value === 2 ? 1 : 0, ['mixed']);
}

fillOneBtn.addEventListener('click', async () => {
  showError('');
  updateFillBuckets(-1); // optimistic — animates immediately, confirmed by the next poll
  const result = await window.plcAPI.setFillingDirection('one');
  if (!result.ok) showError(`Filling One failed: ${result.error}`);
});

fillTwoBtn.addEventListener('click', async () => {
  showError('');
  updateFillBuckets(1);
  const result = await window.plcAPI.setFillingDirection('two');
  if (!result.ok) showError(`Filling Two failed: ${result.error}`);
});

fillBothBtn.addEventListener('click', async () => {
  showError('');
  updateFillBuckets(2);
  const result = await window.plcAPI.setFillingDirection('both');
  if (!result.ok) showError(`Filling Both failed: ${result.error}`);
});

// ---------------------------------------------------------------------------
// Bit controls
// ---------------------------------------------------------------------------

// All three (Stock Refill / Filling One / Filling Two) are momentary —
// click pulses the bit HIGH briefly then back LOW, same pattern as
// Stop/Reset, rather than a persistent toggle state.
function bindPulseButton(btnEl, target, label, pulseMs = 500) {
  btnEl.addEventListener('click', async () => {
    showError('');
    btnEl.disabled = true;
    try {
      let result = await window.plcAPI.writeBit(target, 1);
      if (!result.ok) {
        showError(`${label} pulse failed: ${result.error}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pulseMs));
      result = await window.plcAPI.writeBit(target, 0);
      if (!result.ok) {
        showError(`${label} release failed: ${result.error}`);
      }
    } finally {
      btnEl.disabled = !isConnected;
    }
  });
}

bindPulseButton(refillPulseBtn, 'refill', 'Stock Refill');
bindPulseButton(fill1PulseBtn, 'fill1', 'Filling One');
bindPulseButton(fill2PulseBtn, 'fill2', 'Filling Two');

// ---------------------------------------------------------------------------
// Section navigation — every button (Product Selection / OEE Dashboard /
// Inventory / Production Reports) opens as a popup modal, same pattern as
// each other: fixed overlay + centered box + BACK button + click-outside
// or BACK to close.
// ---------------------------------------------------------------------------
function openModal(overlayEl) {
  overlayEl.style.display = 'flex';
}

function closeModal(overlayEl) {
  overlayEl.style.display = 'none';
}

function bindModal(navBtn, overlayEl, closeBtn, onOpen) {
  navBtn.addEventListener('click', () => {
    openModal(overlayEl);
    if (onOpen) onOpen();
  });
  closeBtn.addEventListener('click', () => closeModal(overlayEl));
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeModal(overlayEl);
  });
}

bindModal(navProductSelection, productSelectionOverlay, productSelectionCloseBtn);
bindModal(navInventory, inventoryOverlay, inventoryCloseBtn);
bindModal(navProductionReports, reportsOverlay, reportsCloseBtn, refreshReportSummary);

navOeeDashboard.addEventListener('click', openOeeModal);

// ---------------------------------------------------------------------------
// Production Reports
// ---------------------------------------------------------------------------
async function refreshReportSummary() {
  const result = await window.plcAPI.getReportSummary();
  if (result.ok) {
    reportEntryCount.textContent = result.totalEntries;
    downloadReportBtn.disabled = !isConnected || result.totalEntries === 0;
  }
}

downloadReportBtn.addEventListener('click', async () => {
  reportError.textContent = '';
  downloadReportBtn.disabled = true;
  try {
    const result = await window.plcAPI.downloadReport();
    if (result.ok) {
      reportError.textContent = '';
      captureLog.textContent = `Report saved: ${result.path} (${result.totalEntries} entries)`;
    } else {
      reportError.textContent = result.error;
    }
  } finally {
    downloadReportBtn.disabled = !isConnected;
  }
});

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
    lastClassification.textContent = statusLabel(result.classification);
    lastRedBalls.textContent = result.redBalls ?? '--';
    lastBlueBalls.textContent = result.blueBalls ?? '--';

    if (result.counts) {
      passCountEl.textContent = result.counts.pass;
      rejectCountEl.textContent = result.counts.reject;
      unknownCountEl.textContent = result.counts.unknown;
    }

    updateResultBanner(result.classification);

    // Every capture updates the Production Reports entry count too, so
    // it stays fresh if that popup happens to already be open.
    if (reportsOverlay.style.display !== 'none') {
      refreshReportSummary();
    } else {
      downloadReportBtn.disabled = !isConnected; // will be re-checked when the popup opens
    }

    // Analysis errors/notes go in captureLog, NOT the shared error banner —
    // the dashboard poll clears that banner every ~800ms, so a real error
    // here would flash and disappear before it could ever be read.
    if (result.analysisError) {
      captureLog.textContent = `Capture #${captureCount} (Batch ${result.batchNumber}) saved, but analysis FAILED: ${result.analysisError}`;
    } else if (result.analysisNote) {
      captureLog.textContent = `Capture #${captureCount} (Batch ${result.batchNumber}) saved: ${result.path} — Note: ${result.analysisNote}`;
    } else {
      captureLog.textContent = `Capture #${captureCount} (Batch ${result.batchNumber}) saved: ${result.path}`;
    }
  } else {
    captureLog.textContent = `Capture #${captureCount} taken, but save failed: ${result.error}`;
  }
}

function statusLabel(classification) {
  if (classification === 'pass') return 'Pass';
  if (classification === 'reject') return 'Reject';
  return 'Unknown';
}

function updateResultBanner(classification) {
  resultBanner.classList.remove('idle', 'good', 'bad', 'unknown');
  if (classification === 'pass') {
    resultBanner.textContent = `✓ PASS — Capture #${captureCount}: box filled correctly`;
    resultBanner.classList.add('good');
  } else if (classification === 'reject') {
    resultBanner.textContent = `✗ REJECT — Capture #${captureCount}: box empty`;
    resultBanner.classList.add('bad');
  } else {
    resultBanner.textContent = `? UNKNOWN — Capture #${captureCount}: could not classify`;
    resultBanner.classList.add('unknown');
  }
}

resetCountsBtn.addEventListener('click', async () => {
  const result = await window.plcAPI.resetCounts();
  if (result.ok) {
    passCountEl.textContent = result.counts.pass;
    rejectCountEl.textContent = result.counts.reject;
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
  if (typeof result.quantity === 'number') {
    currentQuantity = result.quantity;
  }
  updateFillBuckets(result.fillDirection);

  lastUpdate.textContent = `Last update: ${new Date(result.timestamp).toLocaleTimeString()}`;
});

// ---------------------------------------------------------------------------
// OEE Dashboard
// ---------------------------------------------------------------------------
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

  // toFixed(2) here (not just at the main.js source) guarantees exactly
  // 2 decimal places on screen even when the value is a whole number —
  // JS numbers drop trailing zeros (91.30 becomes 91.3, 100.00 becomes
  // 100) unless formatted as a string at display time.
  availabilityValueEl.textContent = Number(result.availability).toFixed(2);
  performanceValueEl.textContent = Number(result.performance).toFixed(2);
  qualityValueEl.textContent = Number(result.quality).toFixed(2);
  oeeValueEl.textContent = Number(result.oee).toFixed(2);
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

oeeCloseBtn.addEventListener('click', closeOeeModal);
oeeOverlay.addEventListener('click', (e) => {
  if (e.target === oeeOverlay) closeOeeModal();
});

// Reset also clears the on-screen Pass/Reject/Unknown image tallies, to
// match the counts main.js resets server-side (M156 is no longer part of
// this at all — only M160 pulses now).
oeeResetBtn.addEventListener('click', async () => {
  showOeeError('');
  const result = await window.plcAPI.resetOEE();
  if (!result.ok) {
    showOeeError(`Reset failed: ${result.error}`);
    return;
  }
  if (result.counts) {
    passCountEl.textContent = result.counts.pass;
    rejectCountEl.textContent = result.counts.reject;
    unknownCountEl.textContent = result.counts.unknown;
  }
  refreshOEE();
});