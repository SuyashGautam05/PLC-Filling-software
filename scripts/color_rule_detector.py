"""
color_rule_detector.py
------------------------
Rule-based detector (mirrors web/script.js exactly):

  - Crop to a Region Of Interest (the bowl interior).
  - Compute HSV saturation per pixel.
  - % of pixels above SAT_THRESHOLD  ->  if over PCT_THRESHOLD, a ball
    is present (something other than white/grey is in the bowl).

No training required. Use this script to test the rule against your
sample photos and tune ROI / thresholds before copying the numbers
into web/script.js's default slider values.

Usage:
    python color_rule_detector.py path/to/image.png
    python color_rule_detector.py --test-all      # run over data/ folders
"""

import sys
import glob
import argparse
import numpy as np
from PIL import Image

# --- Defaults (mirrors the sliders in web/index.html) ------------------
ROI = {"x_pct": 0.14, "y_pct": 0.12, "w_pct": 0.53, "h_pct": 0.56}
SAT_THRESHOLD = 0.45     # 0-1 scale; pixel counted as "coloured" above this
PCT_THRESHOLD = 9.0       # % of ROI pixels that must be coloured to flag a ball


def analyze(image_path, roi=ROI, sat_threshold=SAT_THRESHOLD, pct_threshold=PCT_THRESHOLD):
    img = Image.open(image_path).convert("RGB")
    w, h = img.size

    x0 = int(roi["x_pct"] * w)
    y0 = int(roi["y_pct"] * h)
    x1 = x0 + int(roi["w_pct"] * w)
    y1 = y0 + int(roi["h_pct"] * h)

    crop = img.crop((x0, y0, x1, y1))
    arr = np.array(crop).astype(np.float32) / 255.0

    maxc = arr.max(axis=-1)
    minc = arr.min(axis=-1)
    sat = np.where(maxc == 0, 0, (maxc - minc) / (maxc + 1e-6))

    colored_pct = float((sat > sat_threshold).mean() * 100)
    ball_detected = colored_pct >= pct_threshold

    return {
        "colored_pct": colored_pct,
        "ball_detected": ball_detected,
        "roi_box": (x0, y0, x1, y1),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", nargs="?", help="Path to a single image")
    parser.add_argument("--test-all", action="store_true",
                         help="Run over data/with_balls and data/without_balls")
    args = parser.parse_args()

    if args.test_all:
        correct, total = 0, 0
        for folder, expected in [("data/with_balls", True), ("data/without_balls", False)]:
            print(f"\n=== {folder} (expected: {'ball' if expected else 'empty'}) ===")
            for path in sorted(glob.glob(f"{folder}/*.png") + glob.glob(f"{folder}/*.jpg")):
                r = analyze(path)
                ok = r["ball_detected"] == expected
                correct += ok
                total += 1
                mark = "✓" if ok else "✗ WRONG"
                print(f"  {path:45s} coloured={r['colored_pct']:5.2f}%  "
                      f"-> {'ball' if r['ball_detected'] else 'empty':6s} {mark}")
        print(f"\nAccuracy on sample set: {correct}/{total}")
        return

    if not args.image:
        print("Usage: python color_rule_detector.py <image_path>  OR  --test-all")
        sys.exit(1)

    r = analyze(args.image)
    label = "Ball detected" if r["ball_detected"] else "Empty bowl"
    print(f"{label}  (coloured pixels in ROI: {r['colored_pct']:.2f}%, "
          f"threshold: {PCT_THRESHOLD}%)")


if __name__ == "__main__":
    main()