const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
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
function withLock(fn) {
  const run = modbusChain.then(fn, fn);
  modbusChain = run.then(() => {}, () => {});
  return run;
}
function mbReadCoils(address, count) {
  return withLock(() => client.readCoils(address, count));
}
function mbReadHoldingRegisters(address, count) {
  return withLock(() => client.readHoldingRegisters(address, count));
}
function mbWriteCoil(address, value) {
  return withLock(() => client.writeCoil(address, value));
}
function mbWriteRegister(address, value) {
  return withLock(() => client.writeRegister(address, value));
}
function mbConnectTCP(ip, options) {
  return withLock(() => client.connectTCP(ip, options));
}
function mbClose() {
  return withLock(() => new Promise((resolve) => client.close(resolve)));
}

let pollTimer = null;
let fastTriggerTimer = null;
let fastTriggerBusy = false;
let stopPulseTimer = null;

// M57 camera-trigger edge detection
let m57Prev = false;
let lastCaptureTime = 0;

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

  // OEE Dashboard — each value spans 2 consecutive registers, decoded as
  // a 32-bit IEEE-754 float (see registerPairToFloat32 below), not a
  // single scaled integer. Delta AS-series ISPSoft projects that compute
  // percentages/times via math blocks typically store the result as a
  // native REAL (float) across a D-register pair, which matches what the
  // PLC's own screen shows (e.g. "49.25", "100.00" — genuine decimals,
  // not a display-only scale trick).
  ACTUAL_RUN_D20: 20, // read-only, float32 across D20-D21
  DOWNTIME_D22: 22, // read-only, float32 across D22-D23
  PERF_LOSS_D24: 24, // read-only, float32 across D24-D25
  IDEAL_RUN_D26: 26, // read-only, float32 across D26-D27
  AVAILABILITY_D69: 69, // read-only, float32 across D69-D70
  PERFORMANCE_D87: 87, // read-only, float32 across D87-D88
  QUALITY_D104: 104, // read-only, float32 across D104-D105
  OEE_D150: 150, // read-only, float32 across D150-D151
  OEE_RESET_M156: 156, // write-only pulse — ASSUMED address, adjust if wrong
};

// Which of the 2 registers holds the high vs low 16 bits of the 32-bit
// float. Delta PLCs commonly store the LOW word first (opposite of
// strict Modbus big-endian convention) — that's the default here. If the
// OEE dashboard shows garbled/wildly wrong numbers, flip this to false
// and report what you see so it can be calibrated precisely (same
// approach used for the status-text byte order earlier).
const OEE_LOW_WORD_FIRST = true;

function registerPairToFloat32(reg0, reg1, lowWordFirst) {
  const buf = Buffer.alloc(4);
  if (lowWordFirst) {
    buf.writeUInt16BE(reg1, 0); // high word
    buf.writeUInt16BE(reg0, 2); // low word
  } else {
    buf.writeUInt16BE(reg0, 0); // high word
    buf.writeUInt16BE(reg1, 2); // low word
  }
  return buf.readFloatBE(0);
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
// on the target machine. Checked in this order:
//   1. Packaged app: resources/analyze_box.exe (via extraResources)
//   2. Dev/unpackaged: scripts/dist/analyze_box.exe (PyInstaller's default
//      output location when run from the scripts/ folder)
const COMPILED_ANALYZER_EXE = app.isPackaged
  ? path.join(process.resourcesPath, 'analyze_box.exe')
  : path.join(__dirname, 'scripts', 'dist', 'analyze_box.exe');

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

// Running good/bad tallies (white box = good, black box = bad).
let goodCount = 0;
let badCount = 0;
let unknownCount = 0;

// How many consecutive 16-bit registers to pull for multi-register values.
const STATUS_REG_COUNT = 8; // D1000 status text (ASCII, word order reversed, bytes swapped)
const RFID_REG_COUNT = 1; // D50 RFID tag - single register, plain 4-digit number

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    resizable: true,
    backgroundColor: '#173681',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
      rfidTag: registersToDecimal(rfidRes.data),
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
      mbReadHoldingRegisters(ADDR.ACTUAL_RUN_D20, 2),
      mbReadHoldingRegisters(ADDR.DOWNTIME_D22, 2),
      mbReadHoldingRegisters(ADDR.PERF_LOSS_D24, 2),
      mbReadHoldingRegisters(ADDR.IDEAL_RUN_D26, 2),
      mbReadHoldingRegisters(ADDR.AVAILABILITY_D69, 2),
      mbReadHoldingRegisters(ADDR.PERFORMANCE_D87, 2),
      mbReadHoldingRegisters(ADDR.QUALITY_D104, 2),
      mbReadHoldingRegisters(ADDR.OEE_D150, 2),
    ]);

    const toFloat = (res) => registerPairToFloat32(res.data[0], res.data[1], OEE_LOW_WORD_FIRST);
    const round2 = (v) => Number(v.toFixed(2));

    return {
      ok: true,
      actualRunTime: round2(toFloat(actualRes)),
      downTime: round2(toFloat(downRes)),
      performanceLoss: round2(toFloat(perfLossRes)),
      idealRunTime: round2(toFloat(idealRes)),
      availability: round2(toFloat(availRes)),
      performance: round2(toFloat(perfRes)),
      quality: round2(toFloat(qualRes)),
      oee: round2(toFloat(oeeRes)),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Momentary pulse, same pattern as Stop — write 1 then release after 300ms.
ipcMain.handle('modbus:resetOEE', async () => {
  if (!client.isOpen) return { ok: false, error: 'Not connected to PLC' };
  try {
    await mbWriteCoil(ADDR.OEE_RESET_M156, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await mbWriteCoil(ADDR.OEE_RESET_M156, false);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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
      fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    }
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const filename = `capture_${Date.now()}.png`;
    const filePath = path.join(CAPTURE_DIR, filename);
    fs.writeFileSync(filePath, base64, 'base64');

    const analysis = await analyzeImage(filePath);

    // Strictly binary: filled = good, anything else (empty, or the cup
    // couldn't even be located in frame) = reject. "unknown" is reserved
    // only for a genuine technical failure (the analyzer script crashed),
    // not a product state — when in doubt about the product, reject it.
    let classification = 'unknown';
    if (analysis.ok) {
      if (analysis.fillStatus === 'filled') {
        classification = 'good';
        goodCount += 1;
      } else {
        classification = 'bad';
        badCount += 1;
        pulseBadImagePin(); // fire-and-forget — don't block the response on this
      }
    } else {
      unknownCount += 1;
    }

    return {
      ok: true,
      path: filePath,
      fillStatus: analysis.ok ? analysis.fillStatus : 'unknown',
      confidence: analysis.ok ? analysis.confidence : null,
      classification,
      analysisNote: analysis.ok ? analysis.note : null,
      redBalls: analysis.ok ? analysis.redBalls : null,
      blueBalls: analysis.ok ? analysis.blueBalls : null,
      analysisError: analysis.ok ? null : analysis.error,
      counts: { good: goodCount, bad: badCount, unknown: unknownCount },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('camera:resetCounts', async () => {
  goodCount = 0;
  badCount = 0;
  unknownCount = 0;
  return { ok: true, counts: { good: goodCount, bad: badCount, unknown: unknownCount } };
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

  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  proc.on('error', (err) => {
    // This candidate isn't installed/on PATH — caller may try the next one.
    resolve({ ok: false, error: err.message, retryNextCandidate: true });
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      // Don't give up on the first bad candidate — a broken/stub
      // interpreter (e.g. Windows' python3 Store-alias trap) can exit
      // with a nonzero code instead of a clean spawn error.
      resolve({
        ok: false,
        error: stderr.trim() || `analyzer exited with code ${code}`,
        retryNextCandidate: true,
      });
      return;
    }
    try {
      const parsed = JSON.parse(stdout.trim().split('\n').pop());
      if (parsed.error) {
        resolve({ ok: false, error: parsed.error });
      } else {
        resolve({ ok: true, ...parsed });
      }
    } catch (err) {
      resolve({ ok: false, error: `Could not parse analyzer output: ${stdout || stderr}` });
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