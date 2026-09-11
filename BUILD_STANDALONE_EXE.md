# Building a standalone analyze_box.exe (no Python required on target PC)

Right now the app calls out to a system Python interpreter to run
`analyze_box.py`. That's why it fails with "Python was not found" on any
machine that doesn't have Python (with opencv-python/numpy/pillow)
installed and correctly resolvable on PATH.

Compiling it into a real `.exe` with PyInstaller removes that dependency
entirely — the compiled exe has Python + all its packages baked in.

## One-time setup (on a Windows machine with your working Python + deps)

```powershell
cd scripts
pip install pyinstaller
python -m PyInstaller --onedir --name analyze_box analyze_box.py
```

**Use `--onedir`, not `--onefile`.** `--onefile` packs everything into a
single exe that RE-EXTRACTS the entire bundled Python+OpenCV runtime to a
temp folder on every single launch — since this exe runs once per M57
capture, that adds real, noticeable delay to every single capture.
`--onedir` ships the same files already unpacked in a folder, so each
run just executes directly with no extraction step. `main.js` already
checks for the `--onedir` output location first automatically.

This creates `scripts/dist/analyze_box/` (a folder, not a single file) —
`analyze_box.exe` plus its supporting files live inside it. Test it
directly first, exactly like you'd test the .py version:

```powershell
scripts\dist\analyze_box\analyze_box.exe path\to\some_test_image.png
```

You should see the same JSON output the Python version prints. If it
works here, it'll work from inside the Electron app.

## Using it in development (npm start)

`main.js` already checks for `scripts/dist/analyze_box/analyze_box.exe`
automatically — if it's there, it's used instead of spawning Python. No
code changes needed; just build it once and `npm start` picks it up.

## Using it in a packaged build (npm run build / npm run dist)

The compiled exe needs to be listed as an `extraResources` entry so
electron-builder actually includes it in the packaged app, and so
`main.js` can find it at `process.resourcesPath` at runtime (already
wired up — see `COMPILED_ANALYZER_EXE` near the top of `main.js`).

Add this to `package.json`'s `"build"` section (alongside `"files"`):

```json
"extraResources": [
  {
    "from": "scripts/dist/analyze_box",
    "to": "analyze_box"
  }
]
```

(this copies the whole `analyze_box/` folder — exe plus its supporting
files — not just a single exe file, since `--onedir` output is a folder)

Then build as usual:

```powershell
npm run build
```

The resulting installer now contains the compiled analyzer — no Python
install needed on whatever machine runs it.

## If you update analyze_box.py later

Whenever you change the detection logic (new thresholds, new ROI, etc.),
re-run the PyInstaller command above to regenerate `analyze_box.exe`
before rebuilding the Electron app — the compiled exe is a frozen
snapshot, it does NOT auto-update when you edit the .py source.
