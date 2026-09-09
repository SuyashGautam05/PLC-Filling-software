import numpy as np
from PIL import Image
import colorsys
import glob, os

def analyze(path, roi=None):
    img = Image.open(path).convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    h, w, _ = arr.shape
    if roi:
        x0, y0, x1, y1 = roi
        arr = arr[y0:y1, x0:x1]
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    maxc = np.max(arr, axis=-1)
    minc = np.min(arr, axis=-1)
    sat = np.where(maxc == 0, 0, (maxc - minc) / (maxc + 1e-6))
    return sat, maxc  # saturation, value

# rough ROI guess covering the cup interior region across these fixed-camera shots
ROI = (90, 60, 430, 330)  # x0,y0,x1,y1

for folder in ["data/with_balls", "data/without_balls"]:
    print(f"\n=== {folder} ===")
    for path in sorted(glob.glob(f"/home/claude/ball-detector-ml/{folder}/*.png")):
        sat, val = analyze(path, ROI)
        for thresh in [0.15, 0.2, 0.25, 0.3]:
            pct = (sat > thresh).mean() * 100
            print(f"  {os.path.basename(path):35s} sat>{thresh:.2f}: {pct:5.2f}%", end="")
        print()