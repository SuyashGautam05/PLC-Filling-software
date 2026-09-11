const { app, BrowserWindow, ipcMain, session, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const ModbusRTU = require('modbus-serial');

// Must run before app.whenReady(). Forces Chromium to use the older
// DirectShow video-capture path instead of Media Foundation's hardware
// decoder — the hardware path is what throws "Hardware MFT failed to
// start streaming due to lack of hardware resources" on some Windows
// machines (commonly when the camera is already locked by something
// else, or the hardware decoder conflicts with another app/driver).
app.commandLine.appendSwitch('disable-features', 'MediaFoundationVideoCapture');

let mainWindow;
const client = new ModbusRTU();

// ---------------------------------------------------------------------------
// Modbus request queue. This app has THREE independent polling loops
// sharing the same TCP connection (the fast 50ms M57 trigger loop, the
// main dashboard poll, and the OEE dashboard poll while that popup is
// open) plus on-demand writes from button clicks. Firing overlapping
// requests at the same Modbus TCP socket can desync the protocol or hang
// — this queue guarantees only ONE request is ever in flight at a time,
// regardless of which part of the app asked for it. Every actual wire
// operation goes through mbReadCoils/mbReadHoldingRegisters/mbWriteCoil/
// mbWriteRegister/mbConnectTCP/mbClose below instead of calling the
// `client` object directly.
// ---------------------------------------------------------------------------
let modbusChain = Promise.resolve();

// Hard ceiling on any single Modbus request. Without this, if one request
// ever hangs (network hiccup, PLC momentarily busy, the underlying
// library's own timeout not cleanly rejecting for some reason), the
// whole queue below would wait on it FOREVER — every future operation
// (Start, Stop, the dashboard poll, the M57 trigger loop, everything)
// queued behind it would then hang indefinitely too, since a JS promise
// with no timeout just waits. This is very likely what "Start and other
// buttons hang after a problem occurs" actually was: not anything
// specific to blue-ball detection, but simply that a capture cycle is
// when the most Modbus traffic happens at once, making a stuck request
// more likely to occur right around then.
const REQUEST_TIMEOUT_MS = 3000;

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Modbus request timed out after ${REQUEST_TIMEOUT_MS}ms (${label})`));
    }, REQUEST_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function withLock(fn, label) {
  const run = modbusChain.then(() => withTimeout(Promise.resolve().then(fn), label), () => withTimeout(Promise.resolve().then(fn), label));
  modbusChain = run.then(() => {}, () => {});
  return run;
}
function mbReadCoils(address, count) {
  return withLock(() => client.readCoils(address, count), `readCoils(${address})`);
}
function mbReadHoldingRegisters(address, count) {
  return withLock(() => client.readHoldingRegisters(address, count), `readHoldingRegisters(${address})`);
}
function mbWriteCoil(address, value) {
  return withLock(() => client.writeCoil(address, value), `writeCoil(${address})`);
}
function mbWriteRegister(address, value) {
  return withLock(() => client.writeRegister(address, value), `writeRegister(${address})`);
}
function mbConnectTCP(ip, options) {
  return withLock(() => client.connectTCP(ip, options), `connectTCP(${ip})`);
}
function mbClose() {
  return withLock(() => new Promise((resolve) => client.close(resolve)), 'close');
}

let pollTimer = null;
let fastTriggerTimer = null;
let fastTriggerBusy = false;
let stopPulseTimer = null;

// M57 camera-trigger edge detection
let m57Prev = false;
let lastCaptureTime = 0;

// Continuously kept fresh by the regular dashboard poll (readAll()) below.
// Used by capture logging instead of doing a brand-new isolated Modbus
// read at capture time — that isolated read was the actual bug behind
// "first RFID always shows 0000": the very first capture can happen
// before even one dashboard poll cycle has completed, and a read on a
// freshly-opened connection with no prior activity came back as the
// PLC's uninitialized default. The dashboard poll will have already
// succeeded at least once by the time any real capture is physically
// possible, so reusing its last good value is both more reliable AND
// faster (no extra Modbus round-trip per capture).
let lastKnownRfid = '0000';

// A "run" is one physical batch (e.g. "3 pieces", then "2 pieces", then
// "5 pieces"). The PLC clears D50 back to 0000 when a new run starts and
// only writes the real tag once that run's product is actually tagged/
// completed — so we detect run boundaries directly from those RFID
// transitions rather than guessing from a button press:
//   0000 -> real value  : this run's tag just became known — backfill
//                          every row logged so far in the CURRENT run
//                          that's still showing 0000 with the real tag.
//   real value -> 0000  : a NEW run is starting.
// This is what makes "3 batch, then 2 batch, then 5 batch" distinguishable
// in the CSV (via the Run column) instead of every row just showing
// whatever RFID happened to be cached at that exact moment.
let currentRunId = 1;

// ---------------------------------------------------------------------------
// Address map. This PLC exposes M (bit) and D (word) areas directly, and the
// hardware's own element number IS the 0-based Modbus protocol address:
//   M100 -> Coil address 100        (FC01 read / FC05 write)
//   D2   -> Holding register 2      (FC03 read / FC06 write)
// (Confirmed against the AS-series address table: hex base for both M and D
// areas is 0000, so element number == protocol address.)
// ---------------------------------------------------------------------------
const ADDR = {
  START_M100: 100, // Start, blinks while running
  STOP_M101: 101, // Stop, NC contact -> normally 1, pulse to 0 for 1s to stop
  QTY_D0: 0, // Quantity, software-set, 1-5
  FILL_DIR_D2: 2, // Filling One = -1, Filling Two = +1
  STOCK_D11: 11, // Container stock, read-only
  FILL1_D12: 12, // Filling one level, read-only
  FILL2_D13: 13, // Filling two level, read-only
  REFILL_M153: 153, // Stock refill bit, write-only 0/1
  FILL1_BIT_M154: 154, // Filling one bit, write-only 0/1
  FILL2_BIT_M155: 155, // Filling two bit, write-only 0/1
  STATUS_D1000: 1000, // Status text, read-only
  RFID_D50: 50, // RFID tag, read-only
  CAMERA_TRIGGER_M57: 57, // Camera trigger, read-only
  BAD_IMAGE_M69: 69, // Write-only coil. Pulsed HIGH for 1s when a capture is classified "empty"/bad.

  // OEE Dashboard — each value is a SINGLE 16-bit integer register (not
  // float32). Scaling:
  //   - Time fields (Actual Run, Down Time, Performance Loss, Ideal Run):
  //     raw / 10, one decimal place — e.g. raw 123 displays as 12.3.
  //   - Percent fields (Availability, Performance, Quality, OEE):
  //     raw / 100, two decimal places — e.g. raw 4925 displays as 49.25.
  ACTUAL_RUN_D20: 20,
  DOWNTIME_D22: 22,
  PERF_LOSS_D24: 24,
  IDEAL_RUN_D26: 26,
  AVAILABILITY_D900: 900,
  PERFORMANCE_D902: 902,
  QUALITY_D904: 904,
  OEE_D906: 906,
  OEE_RESET_M160: 160, // write-only pulse, HIGH for 1s, fired on OEE Reset click
};

function scaleTime(raw) {
  return Number((raw / 10).toFixed(1));
}

// Percent fields (Availability/Performance/Quality/OEE): previously
// raw/100. Per request, an additional ×100 is applied on top of that —
// net effect is the raw register value is now displayed directly,
// formatted to 2 decimal places, with no division at all.
function scalePercent(raw) {
  return Number(((raw / 100) * 100).toFixed(2));
}

// Minimum time between two captures, even if M57 pulses again immediately.
const MIN_CAPTURE_INTERVAL_MS = 2000;

// Where captured images are saved.
const CAPTURE_DIR = path.join(app.getPath('userData'), 'captures');

// Python + OpenCV analyzer script (dev/fallback path).
const ANALYZER_SCRIPT = path.join(__dirname, 'scripts', 'analyze_box.py');

// Compiled standalone analyzer (see scripts/BUILD_STANDALONE_EXE.md for how
// to produce this with PyInstaller). If this exists, it's used INSTEAD of
// spawning system Python — the app then needs zero external dependencies
// on the target machine. Checked in this order (first match wins):
//   1. Packaged app, --onedir build: resources/analyze_box/analyze_box.exe
//   2. Packaged app, --onefile build: resources/analyze_box.exe
//   3. Dev, --onedir build: scripts/dist/analyze_box/analyze_box.exe
//   4. Dev, --onefile build: scripts/dist/analyze_box.exe
//
// Prefer --onedir over --onefile: a --onefile exe re-extracts the ENTIRE
// bundled Python+OpenCV runtime to a temp folder on every single launch,
// which is most of what "the image processing feels slow" usually is —
// not the actual analysis. --onedir ships the same files already
// unpacked, so each capture just runs the exe directly with no
// extraction step. Rebuild with:
//   python -m PyInstaller --onedir --name analyze_box analyze_box.py
function resolveCompiledAnalyzerExe() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'analyze_box', 'analyze_box.exe'),
        path.join(process.resourcesPath, 'analyze_box.exe'),
      ]
    : [
        path.join(__dirname, 'scripts', 'dist', 'analyze_box', 'analyze_box.exe'),
        path.join(__dirname, 'scripts', 'dist', 'analyze_box.exe'),
      ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
}
const COMPILED_ANALYZER_EXE = resolveCompiledAnalyzerExe();

// Try 'py' (the Windows Python Launcher) first — it's installed by the
// official python.org installer at a fixed system location and is NOT
// affected by Windows' "python"/"python3" App Execution Alias stubs,
// which silently redirect to the Microsoft Store instead of a real
// interpreter on many Windows machines (that's what "Python was not
// found; run without arguments to install from the Microsoft Store..."
// means — the OS intercepted the command before Node even got involved).
//
// The two hardcoded paths below are a direct fallback for this specific
// machine (confirmed via `where python` in PowerShell) for when even
// 'py'/'python'/'python3' don't resolve correctly from Electron's spawned
// child process — its PATH can differ from an interactive terminal's.
// If Python gets reinstalled/moved, update these to match `where python`.
// NOTE: none of this matters once COMPILED_ANALYZER_EXE exists — these
// are only used as a fallback when no compiled exe is found.
const PYTHON_CANDIDATES = [
  'py',
  'python',
  'python3',
  'C:\\Python314\\python.exe',
  'C:\\Users\\Scientech 2652\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
];

// Running pass/reject tallies.
let passCount = 0;
let rejectCount = 0;
let unknownCount = 0;

// Production report log — one entry per capture, used for the Production
// Reports CSV export. Batch numbers are auto-generated sequentially in
// software (no PLC register was specified for this), starting at 1 and
// incrementing per capture regardless of pass/reject outcome.
let captureReportLog = [];
let nextBatchNumber = 1;

function nowInIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

// How many consecutive 16-bit registers to pull for multi-register values.
const STATUS_REG_COUNT = 8; // D1000 status text (ASCII, word order reversed, bytes swapped)
const RFID_REG_COUNT = 1; // D50 RFID tag - single register, plain 4-digit number

// App icon. __dirname is checked FIRST for the packaged case — with
// asar:false and "logo.ico" listed in package.json's "files", it gets
// copied to the same folder as main.js itself (resources/app/logo.ico),
// which IS __dirname at runtime. process.resourcesPath (resources/ one
// level up) is only where "extraResources" entries land, not "files"
// entries — that mismatch was likely why earlier attempts kept failing.
//
// Uses nativeImage explicitly (not just a raw path string) and logs
// loudly to the console if it can't find or can't load the file, so if
// this is STILL broken after this fix, the console output on a
// `npm start` run (or via `--enable-logging` on the packaged exe) will
// say exactly why instead of silently showing nothing.
function resolveAppIconPath() {
  // We now look for icon.png (electron-builder handles the .ico generation automatically)
  const candidates = app.isPackaged
    ? [
        // extraResources copy in packaged app
        path.join(process.resourcesPath, 'icon.png'),
        // asar:false unpacked copy
        path.join(__dirname, 'build', 'icon.png'),
      ]
    : [
        // Dev mode
        path.join(__dirname, 'build', 'icon.png'),
      ];

  const found = candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  
  if (!found) {
    console.error(
      '[icon] No icon file found. Checked:\n' + candidates.map((p) => `  - ${p}`).join('\n')
    );
  }
  return found || candidates[0];
}

function resolveAppIcon() {
  const iconPath = resolveAppIconPath();
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      console.error(`[icon] nativeImage could not load file at ${iconPath}. Ensure it is a valid PNG.`);
      return nativeImage.createEmpty();
    }
    console.log(`[icon] Loaded app icon from ${iconPath} (${image.getSize().width}x${image.getSize().height})`);
    return image;
  } catch (err) {
    console.error(`[icon] Error loading icon:`, err);
    return nativeImage.createEmpty();
  }
}

function createWindow() {
  const appIcon = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    resizable: true,
    backgroundColor: '#173681',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    },
  });

  // Redundant explicit call — on some Windows/Electron combinations the
  // constructor's `icon` option alone doesn't reliably refresh the
  // taskbar icon specifically, even though it works fine for the window
  // titlebar. Calling setIcon() after creation covers that gap.
  if (!appIcon.isEmpty()) {
    mainWindow.setIcon(appIcon);
  }

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  // Electron blocks camera/mic access by default for pages loaded with
  // loadFile() (file:// origin) unless we explicitly allow it here.
  // Without this, getUserMedia() silently rejects and no picture is ever
  // taken when M57 goes high.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['media', 'camera', 'microphone'].includes(permission));
  });

  if (session.defaultSession.setPermissionCheckHandler) {
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return ['media', 'camera', 'microphone'].includes(permission);
    });
  }

  createWindow();
});

app.on('window-all-closed', () => {
  stopPolling();
  if (client.isOpen) mbClose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (fastTriggerTimer) {
    clearInterval(fastTriggerTimer);
    fastTriggerTimer = null;
  }
  fastTriggerBusy = false;
  m57Prev = false;
}

// Dedicated, lightweight poll loop that ONLY reads M57. Kept separate from
// the heavier dashboard poll (which reads 9 registers/coils per cycle) so a
// short M57 pulse has a much better chance of being caught — a single-coil
// read round-trips far faster than the full dashboard bundle.
function startFastTriggerLoop() {
  if (fastTriggerTimer) clearInterval(fastTriggerTimer);

  fastTriggerTimer = setInterval(async () => {
    if (fastTriggerBusy || !client.isOpen) return;
    fastTriggerBusy = true;
    try {
      const res = await mbReadCoils(ADDR.CAMERA_TRIGGER_M57, 1);
      const high = !!res.data[0];
      let fireCapture = false;

      if (high && !m57Prev) {
        const now = Date.now();
        if (now - lastCaptureTime >= MIN_CAPTURE_INTERVAL_MS) {
          fireCapture = true;
          lastCaptureTime = now;
        }
      }
      m57Prev = high;

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('camera:trigger', { high, fireCapture });
      }
    } catch (err) {
      // Ignore transient read errors on the fast loop; the dashboard poll
      // will surface connection problems.
    } finally {
      fastTriggerBusy = false;
    }
  }, 50); // check M57 roughly every 50ms
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
ipcMain.handle('modbus:connect', async (event, config) => {
  const { ip, port, slaveId } = config;
  try {
    if (client.isOpen) {
      await mbClose();
    }
    await mbConnectTCP(ip, { port: Number(port) || 502 });
    client.setID(Number(slaveId) || 1);
    client.setTimeout(2000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('modbus:disconnect', async () => {
  stopPolling();
  if (stopPulseTimer) clearTimeout(stopPulseTimer);
  try {
    if (client.isOpen) {
      await mbClose();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Polling (read-only values + status bits)
// ---------------------------------------------------------------------------
ipcMain.handle('modbus:readOnce', async () => readAll());

ipcMain.handle('modbus:startPolling', async (event, config) => {
  stopPolling();
  const intervalMs = Number(config.interval) || 800;

  pollTimer = setInterval(async () => {
    const result = await readAll();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('modbus:data', result);
    }
  }, intervalMs);

  startFastTriggerLoop();

  return { ok: true };
});

ipcMain.handle('modbus:stopPolling', async () => {
  stopPolling();
  return { ok: true };
});

async function readAll() {
  if (!client.isOpen) {
    return { ok: false, error: 'Not connected to PLC' };
  }

  try {
    const [
      startRes,
      stopRes,
      qtyRes,
      fillDirRes,
      stockRes,
      fill1Res,
      fill2Res,
      statusRes,
      rfidRes,
      cameraRes,
    ] = await Promise.all([
      mbReadCoils(ADDR.START_M100, 1),
      mbReadCoils(ADDR.STOP_M101, 1),
      mbReadHoldingRegisters(ADDR.QTY_D0, 1),
      mbReadHoldingRegisters(ADDR.FILL_DIR_D2, 1),
      mbReadHoldingRegisters(ADDR.STOCK_D11, 1),
      mbReadHoldingRegisters(ADDR.FILL1_D12, 1),
      mbReadHoldingRegisters(ADDR.FILL2_D13, 1),
      mbReadHoldingRegisters(ADDR.STATUS_D1000, STATUS_REG_COUNT),
      mbReadHoldingRegisters(ADDR.RFID_D50, RFID_REG_COUNT),
      mbReadCoils(ADDR.CAMERA_TRIGGER_M57, 1),
    ]);

    // The fast dedicated M57 loop (see startFastTriggerLoop) is now the
    // real capture trigger, since it polls much faster than this bundled
    // dashboard read. This just reports the current M57 state for display.
    const cameraTriggerHigh = !!cameraRes.data[0];

    const rfidTag = registersToDecimal(rfidRes.data);

    if (rfidTag === '0000' && lastKnownRfid !== '0000') {
      // Tag cleared by the PLC -> a new run is starting.
      currentRunId += 1;
    } else if (rfidTag !== '0000' && lastKnownRfid === '0000') {
      // Tag just became known -> backfill every still-pending row from
      // this run with the real value instead of leaving it as 0000.
      captureReportLog.forEach((entry) => {
        if (entry.runId === currentRunId && entry.rfid === '0000') {
          entry.rfid = rfidTag;
        }
      });
    }
    lastKnownRfid = rfidTag; // keep the capture-time cache fresh

    return {
      ok: true,
      running: !!startRes.data[0],
      stopContact: !!stopRes.data[0],
      quantity: qtyRes.data[0],
      fillDirection: toSigned16(fillDirRes.data[0]),
      containerStock: stockRes.data[0],
      fillingOneLevel: fill1Res.data[0],
      fillingTwoLevel: fill2Res.data[0],
      statusText: registersToAscii(statusRes.data),
      rfidTag,
      cameraTriggerHigh,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Start: set M100 = 1. The PLC itself blinks it; the UI mirrors that state.
ipcMain.handle('modbus:start', async () => writeCoilSafe(ADDR.START_M100, true));

// Stop: M101 is a Normally-Closed contact (rests at 1). Pulse it to 0 for
// exactly 1 second, then release it back to 1, to trigger a stop.
ipcMain.handle('modbus:stop', async () => {
  if (!client.isOpen) return { ok: false, error: 'Not connected to PLC' };
  try {
    await mbWriteCoil(ADDR.STOP_M101, false);
    await new Promise((resolve) => {
      stopPulseTimer = setTimeout(resolve, 1000);
    });
    await mbWriteCoil(ADDR.STOP_M101, true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Quantity: D0, software sets 1-5.
ipcMain.handle('modbus:setQuantity', async (event, value) => {
  const qty = Number(value);
  if (!Number.isInteger(qty) || qty < 1 || qty > 5) {
    return { ok: false, error: 'Quantity must be an integer between 1 and 5' };
  }
  return writeRegisterSafe(ADDR.QTY_D0, qty);
});

// Filling direction: D2. Filling One = -1, Filling Two = +1, Both = 2.
ipcMain.handle('modbus:setFillingDirection', async (event, direction) => {
  const map = { one: -1, two: 1, both: 2 };
  const value = map[direction];
  if (value === undefined) {
    return { ok: false, error: "direction must be 'one', 'two', or 'both'" };
  }
  return writeRegisterSafe(ADDR.FILL_DIR_D2, toUnsigned16(value));
});

// Bit writes: M153 (stock refill), M154 (filling one), M155 (filling two).
// Each accepts only 0 or 1.
ipcMain.handle('modbus:writeBit', async (event, { target, value }) => {
  const map = {
    refill: ADDR.REFILL_M153,
    fill1: ADDR.FILL1_BIT_M154,
    fill2: ADDR.FILL2_BIT_M155,
  };
  const address = map[target];
  if (address === undefined) {
    return { ok: false, error: `Unknown bit target: ${target}` };
  }
  if (value !== 0 && value !== 1) {
    return { ok: false, error: 'Value must be 0 or 1' };
  }
  return writeCoilSafe(address, !!value);
});

// ---------------------------------------------------------------------------
// OEE Dashboard
// ---------------------------------------------------------------------------
ipcMain.handle('modbus:readOEE', async () => {
  if (!client.isOpen) return { ok: false, error: 'Not connected to PLC' };
  try {
    const [actualRes, downRes, perfLossRes, idealRes, availRes, perfRes, qualRes, oeeRes] = await Promise.all([
      mbReadHoldingRegisters(ADDR.ACTUAL_RUN_D20, 1),
      mbReadHoldingRegisters(ADDR.DOWNTIME_D22, 1),
      mbReadHoldingRegisters(ADDR.PERF_LOSS_D24, 1),
      mbReadHoldingRegisters(ADDR.IDEAL_RUN_D26, 1),
      mbReadHoldingRegisters(ADDR.AVAILABILITY_D900, 1),
      mbReadHoldingRegisters(ADDR.PERFORMANCE_D902, 1),
      mbReadHoldingRegisters(ADDR.QUALITY_D904, 1),
      mbReadHoldingRegisters(ADDR.OEE_D906, 1),
    ]);

    return {
      ok: true,
      actualRunTime: scaleTime(actualRes.data[0]),
      downTime: scaleTime(downRes.data[0]),
      performanceLoss: scaleTime(perfLossRes.data[0]),
      idealRunTime: scaleTime(idealRes.data[0]),
      availability: scalePercent(availRes.data[0]),
      performance: scalePercent(perfRes.data[0]),
      quality: scalePercent(qualRes.data[0]),
      oee: scalePercent(oeeRes.data[0]),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Pulses M160 HIGH for exactly 1 second, and also resets the pass/reject/
// unknown image tallies (M156 has been removed from this handler entirely
// per request — only M160 fires now).
ipcMain.handle('modbus:resetOEE', async () => {
  if (!client.isOpen) return { ok: false, error: 'Not connected to PLC' };
  try {
    await pulseM160();
    passCount = 0;
    rejectCount = 0;
    unknownCount = 0;
    return { ok: true, counts: { pass: passCount, reject: rejectCount, unknown: unknownCount } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function pulseM160() {
  try {
    await mbWriteCoil(ADDR.OEE_RESET_M160, true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await mbWriteCoil(ADDR.OEE_RESET_M160, false);
  } catch (err) {
    console.error('pulseM160 failed:', err.message);
  }
}

// Pulses M69 HIGH for 1 second whenever a capture is classified "empty"/bad.
// Fire-and-forget: called without awaiting, so a bad-image reject signal
// doesn't delay the classification result getting back to the UI.
async function pulseBadImagePin() {
  if (!client.isOpen) return;
  try {
    await mbWriteCoil(ADDR.BAD_IMAGE_M69, true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await mbWriteCoil(ADDR.BAD_IMAGE_M69, false);
  } catch (err) {
    console.error('pulseBadImagePin failed:', err.message);
  }
}

async function writeCoilSafe(address, boolValue) {
  if (!client.isOpen) return { ok: false, error: 'Not connected to PLC' };
  try {
    await mbWriteCoil(address, boolValue);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function writeRegisterSafe(address, value) {
  if (!client.isOpen) return { ok: false, error: 'Not connected to PLC' };
  try {
    await mbWriteRegister(address, value);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Camera capture storage + fill-status classification
// ---------------------------------------------------------------------------
ipcMain.handle('camera:saveImage', async (event, dataUrl) => {
  try {
    if (!fs.existsSync(CAPTURE_DIR)) {
      await fsp.mkdir(CAPTURE_DIR, { recursive: true });
    }
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const filename = `capture_${Date.now()}.png`;
    const filePath = path.join(CAPTURE_DIR, filename);
    await fsp.writeFile(filePath, base64, 'base64');

    const analysis = await analyzeImage(filePath);

    // JS-side compensation for a known inconsistency in the Python
    // analyzer's own decision logic: `fillStatus` can say "empty" even
    // when `redBalls`/`blueBalls` (computed via a more lenient — and
    // more correct — check with no extra percentage-of-cup-area gate)
    // found a ball. Rather than trust `fillStatus` blindly, treat "a
    // ball was actually counted" as the stronger signal and override
    // fillStatus to "filled" when they disagree. This is intentionally
    // NOT a Python change — analyze_box.py is being kept as-is.
    let effectiveFillStatus = analysis.ok ? analysis.fillStatus : 'unknown';
    if (analysis.ok && effectiveFillStatus !== 'filled') {
      const ballsCounted = (analysis.redBalls > 0) || (analysis.blueBalls > 0);
      if (ballsCounted) {
        console.log(
          `[fill-override] analyzer said fillStatus="${analysis.fillStatus}" but ` +
          `redBalls=${analysis.redBalls} blueBalls=${analysis.blueBalls} — overriding to "filled".`
        );
        effectiveFillStatus = 'filled';
      }
    }

    // Strictly binary: filled = Pass, anything else (empty, or the cup
    // couldn't even be located in frame) = Reject. "unknown" is reserved
    // only for a genuine technical failure (the analyzer script crashed),
    // not a product state — when in doubt about the product, reject it.
    let classification = 'unknown';
    if (analysis.ok) {
      if (effectiveFillStatus === 'filled') {
        classification = 'pass';
        passCount += 1;
      } else {
        classification = 'reject';
        rejectCount += 1;
        pulseBadImagePin(); // fire-and-forget — don't block the response on this
      }
    } else {
      unknownCount += 1;
    }

    // Use the RFID value already kept fresh by the ongoing dashboard poll
    // (see lastKnownRfid) rather than an isolated one-off read here — that
    // isolated read was the actual cause of "first RFID always 0000": the
    // very first capture can happen before even one dashboard poll cycle
    // completes, and a read on a connection with no prior activity came
    // back as the PLC's uninitialized default.
    const rfidTag = lastKnownRfid;

    // Fill One / Fill Two checkbox columns: whether a red ball (Filling
    // One) / blue ball (Filling Two) was detected in this capture. This
    // assumes Filling One = red, Filling Two = blue, matching the D2
    // filling-direction naming used elsewhere in this app — flag if that
    // assumption is wrong.
    const fillOneDetected = analysis.ok ? (analysis.redBalls > 0) : false;
    const fillTwoDetected = analysis.ok ? (analysis.blueBalls > 0) : false;

    const batchNumber = nextBatchNumber++;
    const statusLabel = classification === 'pass' ? 'Pass' : classification === 'reject' ? 'Reject' : 'Unknown';

    captureReportLog.push({
      runId: currentRunId,
      batchNumber,
      timestamp: nowInIST(),
      fillOne: fillOneDetected,
      fillTwo: fillTwoDetected,
      rfid: rfidTag,
      status: statusLabel,
    });

    return {
      ok: true,
      path: filePath,
      fillStatus: effectiveFillStatus,
      confidence: analysis.ok ? analysis.confidence : null,
      classification,
      batchNumber,
      rfid: rfidTag,
      analysisNote: analysis.ok ? analysis.note : null,
      redBalls: analysis.ok ? analysis.redBalls : null,
      blueBalls: analysis.ok ? analysis.blueBalls : null,
      analysisError: analysis.ok ? null : analysis.error,
      counts: { pass: passCount, reject: rejectCount, unknown: unknownCount },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('camera:resetCounts', async () => {
  passCount = 0;
  rejectCount = 0;
  unknownCount = 0;
  return { ok: true, counts: { pass: passCount, reject: rejectCount, unknown: unknownCount } };
});

// ---------------------------------------------------------------------------
// Production Reports — CSV export of the capture log (Timestamp/IST,
// Batch Number, Fill One, Fill Two, RFID, Status). Opens a native Save
// dialog rather than a silent browser-style download, since this is a
// desktop app. NOTE: CSV can't embed a real interactive Excel checkbox
// form control — Fill One/Fill Two are written as TRUE/FALSE, which Excel
// will happily open and let you filter/sort on, but they render as text,
// not a clickable checkbox widget. A genuine clickable-checkbox .xlsx
// would need a heavier library (e.g. exceljs) — say the word if that
// level of fidelity is actually required.
function buildReportCsv() {
  // "Run" distinguishes separate physical batches (e.g. a run of 3
  // pieces, then a run of 2, then a run of 5) — without it every row just
  // looked identical/sequential with no way to tell which batch a given
  // row belonged to.
  const header = ['Timestamp (IST)', 'Run', 'Batch Number', 'Fill One', 'Fill Two', 'RFID', 'Status'];
  const escapeCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = captureReportLog.map((e) => [
    e.timestamp,
    e.runId,
    e.batchNumber,
    e.fillOne ? 'TRUE' : 'FALSE',
    e.fillTwo ? 'TRUE' : 'FALSE',
    e.rfid,
    e.status,
  ]);
  return [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

ipcMain.handle('reports:getSummary', async () => {
  return { ok: true, totalEntries: captureReportLog.length };
});

ipcMain.handle('reports:download', async () => {
  if (captureReportLog.length === 0) {
    return { ok: false, error: 'No captures logged yet — nothing to export.' };
  }
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Production Report',
      defaultPath: `Production_Report_${Date.now()}.csv`,
      filters: [{ name: 'CSV (opens in Excel)', extensions: ['csv'] }],
    });
    if (canceled || !filePath) {
      return { ok: false, error: 'Save cancelled.' };
    }
    await fsp.writeFile(filePath, buildReportCsv(), 'utf8');
    return { ok: true, path: filePath, totalEntries: captureReportLog.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Runs the Python/OpenCV analyzer on a saved image and parses its JSON output.
function analyzeImage(imagePath) {
  return new Promise((resolve) => {
    if (fs.existsSync(COMPILED_ANALYZER_EXE)) {
      // Standalone compiled analyzer — no Python interpreter needed at
      // all. Call it directly with just the image path; it prints the
      // same JSON shape the .py version does.
      runAnalyzerProcess(COMPILED_ANALYZER_EXE, [imagePath], resolve);
      return;
    }
    // Fall back to spawning a system Python interpreter running the .py
    // script — only reached in dev, or if the compiled exe hasn't been
    // built yet (see scripts/BUILD_STANDALONE_EXE.md).
    tryPython(PYTHON_CANDIDATES, 0, imagePath, resolve);
  });
}

function tryPython(candidates, index, imagePath, resolve) {
  if (index >= candidates.length) {
    resolve({
      ok: false,
      error:
        'No working python interpreter found, and no compiled analyze_box.exe present. ' +
        'Either install Python (py/python/python3 on PATH) with opencv-python/numpy/pillow, ' +
        'or build the standalone exe — see scripts/BUILD_STANDALONE_EXE.md.',
    });
    return;
  }
  runAnalyzerProcess(candidates[index], [ANALYZER_SCRIPT, imagePath], (result) => {
    if (!result.ok && result.retryNextCandidate && index + 1 < candidates.length) {
      tryPython(candidates, index + 1, imagePath, resolve);
      return;
    }
    resolve(result);
  });
}

// Spawns either the compiled exe (command=exe path, args=[imagePath]) or a
// python interpreter (command=python, args=[scriptPath, imagePath]) and
// parses its JSON stdout the same way either way.
// If a specific frame ever causes the analyzer to hang instead of crash
// cleanly, this guarantees it still gets killed and resolved instead of
// leaving that one capture stuck forever (each capture is otherwise
// independent of the Modbus queue, but there's no reason to let a stuck
// analysis linger indefinitely either).
const ANALYZER_TIMEOUT_MS = 10000;

// The exact folder Python's own LOG_PATH will resolve to — computed the
// same way Python does it (same directory as whichever file is actually
// invoked). If you're running the compiled exe, this is NOT the same
// folder as your source analyze_box.py — that mismatch (checking the
// wrong folder) is the most common reason "the log isn't showing up".
const EXPECTED_ANALYZER_LOG_PATH = path.join(path.dirname(COMPILED_ANALYZER_EXE), 'analyze_box.log');

// A second, JS-side log that's ALWAYS in a guaranteed-writable, always-
// findable location (Electron's userData folder) regardless of where
// the analyzer binary/script lives or whether it can write next to
// itself (e.g. if installed under Program Files without write access).
// This captures stdout/stderr from every single run — a reliable
// fallback even if Python's own file-based log is inaccessible or in an
// unexpected location.
const JS_SIDE_ANALYZER_LOG_PATH = path.join(app.getPath('userData'), 'analyzer-runs.log');

console.log(`[analyzer] Expecting Python's own log at: ${EXPECTED_ANALYZER_LOG_PATH}`);
console.log(`[analyzer] JS-side capture of every run's stdout/stderr at: ${JS_SIDE_ANALYZER_LOG_PATH}`);

function appendJsSideAnalyzerLog(imagePath, stdout, stderr, exitInfo) {
  const entry =
    `\n----- ${new Date().toISOString()} -----\n` +
    `image: ${imagePath}\n` +
    `exit: ${exitInfo}\n` +
    `stdout: ${stdout.trim() || '(empty)'}\n` +
    `stderr: ${stderr.trim() || '(empty)'}\n`;
  fs.appendFile(JS_SIDE_ANALYZER_LOG_PATH, entry, (err) => {
    if (err) console.error('[analyzer] Failed to write JS-side analyzer log:', err.message);
  });
}

function runAnalyzerProcess(command, args, resolve) {
  let proc;
  try {
    proc = spawn(command, args);
  } catch (err) {
    resolve({ ok: false, error: err.message, retryNextCandidate: true });
    return;
  }

  let stdout = '';
  let stderr = '';
  let settled = false;
  const imagePathArg = args[args.length - 1];

  const timeoutTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    proc.kill();
    appendJsSideAnalyzerLog(imagePathArg, stdout, stderr, `killed after ${ANALYZER_TIMEOUT_MS}ms timeout`);
    resolve({ ok: false, error: `Analyzer did not finish within ${ANALYZER_TIMEOUT_MS}ms — killed.` });
  }, ANALYZER_TIMEOUT_MS);

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    resolve(result);
  };

  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  proc.on('error', (err) => {
    // This candidate isn't installed/on PATH — caller may try the next one.
    appendJsSideAnalyzerLog(imagePathArg, stdout, stderr, `spawn error: ${err.message}`);
    finish({ ok: false, error: err.message, retryNextCandidate: true });
  });

  proc.on('close', (code) => {
    appendJsSideAnalyzerLog(imagePathArg, stdout, stderr, `exit code ${code}`);
    if (code !== 0) {
      // Don't give up on the first bad candidate — a broken/stub
      // interpreter (e.g. Windows' python3 Store-alias trap) can exit
      // with a nonzero code instead of a clean spawn error.
      finish({
        ok: false,
        error: stderr.trim() || `analyzer exited with code ${code}`,
        retryNextCandidate: true,
      });
      return;
    }
    try {
      const parsed = JSON.parse(stdout.trim().split('\n').pop());
      if (parsed.error) {
        finish({ ok: false, error: parsed.error });
      } else {
        finish({ ok: true, ...parsed });
      }
    } catch (err) {
      finish({ ok: false, error: `Could not parse analyzer output: ${stdout || stderr}` });
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toSigned16(value) {
  if (value === undefined) return 0;
  return value > 0x7fff ? value - 0x10000 : value;
}

function toUnsigned16(value) {
  return value < 0 ? 0x10000 + value : value;
}

function registersToAscii(registers) {
  // Confirmed from an actual jumbled reading: "BATCH COMPLETE" was coming
  // out as "ETPMEL HOCABCT" — every 2-character register was byte-swapped
  // (BA->AB, TC->CT, H_-> _H, etc.) with NO word/register reordering
  // needed. So: keep registers in their natural address order, and just
  // swap the low/high byte within each register.
  let text = '';
  registers.forEach((reg) => {
    const hi = (reg >> 8) & 0xff;
    const lo = reg & 0xff;
    [lo, hi].forEach((code) => {
      if (code >= 32 && code <= 126) text += String.fromCharCode(code);
    });
  });
  return text.trim();
}

function registersToDecimal(registers) {
  // RFID tag is a single register holding a plain 4-digit decimal number.
  const value = registers[0] ?? 0;
  return String(value).padStart(4, '0');
}