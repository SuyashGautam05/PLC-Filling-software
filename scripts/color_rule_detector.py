"""
color_rule_detector.py
------------------------
Standalone hue-based detector. This file and live_test.py each contain
their own copy of the detection logic below (ROI, COLOR_RULES,
rgb_to_hue_sat, blob filtering). THEY MUST BE KEPT IN SYNC BY HAND - if
you tune a threshold here, copy the same change into live_test.py, or
the live camera app will quietly behave differently than what you
validated with --test-all.

  - Crop to a Region Of Interest (the bowl interior).
  - Classify each pixel as red-ish / blue-ish / neither, using hue
    bands + a per-color saturation floor (blue's floor is lower than
    red's, since AWB + glossy highlights wash blue out more on camera).
  - Drop tiny stray colored blobs (glare, noise) below MIN_BLOB_AREA_PX.
  - % of remaining pixels above each color's PCT_THRESHOLD -> ball
    of that color present.

Usage:
    python color_rule_detector.py path/to/image.png
    python color_rule_detector.py --test-all        # accuracy over data/
    python color_rule_detector.py --calibrate img1.png img2.png ...
        -> prints real hue/saturation stats from your own images so you
           can set COLOR_RULES from data, not guesses. Best used on
           close-up crops of just the ball (no bowl/background).
"""

import sys
import glob
import argparse
import numpy as np
from PIL import Image
import cv2

# ---------------------------------------------------------------------
# ROI (as % of image width/height)
# ---------------------------------------------------------------------
ROI = {"x_pct": 0.14, "y_pct": 0.12, "w_pct": 0.53, "h_pct": 0.56}

# ---------------------------------------------------------------------
# Per-color tuning. Hue is in degrees (0-360, standard HSV hue wheel).
# Use --calibrate on real photos to set these from data.
# KEEP THIS BLOCK IDENTICAL TO THE ONE IN live_test.py.
# ---------------------------------------------------------------------
COLOR_RULES = {
    "red": {
        "hue_ranges": [(0, 18), (345, 360)],  # red wraps around 0/360
        "sat_min": 0.35,
        "pct_threshold": 6.0,
    },
    "blue": {
        "hue_ranges": [(185, 255)],
        "sat_min": 0.18,
        "pct_threshold": 5.0,
    },
}

MIN_BLOB_AREA_PX = 25  # ignore any contiguous colored region smaller than this (noise/glare)


def rgb_to_hue_sat(rgb_float):
    """Vectorized RGB [0,1] -> (hue in degrees 0-360, saturation 0-1)."""
    r, g, b = rgb_float[..., 0], rgb_float[..., 1], rgb_float[..., 2]
    maxc = np.max(rgb_float, axis=-1)
    minc = np.min(rgb_float, axis=-1)
    delta = maxc - minc

    sat = np.where(maxc <= 1e-6, 0.0, delta / (maxc + 1e-6))

    safe_delta = np.where(delta <= 1e-6, 1.0, delta)  # avoid div/0; masked out below anyway
    is_r_max = (maxc == r) & (delta > 1e-6)
    is_g_max = (maxc == g) & (delta > 1e-6) & ~is_r_max
    is_b_max = (maxc == b) & (delta > 1e-6) & ~is_r_max & ~is_g_max

    hue = np.zeros_like(maxc)
    hue = np.where(is_r_max, (60 * (((g - b) / safe_delta) % 6)), hue)
    hue = np.where(is_g_max, (60 * (((b - r) / safe_delta) + 2)), hue)
    hue = np.where(is_b_max, (60 * (((r - g) / safe_delta) + 4)), hue)
    hue = hue % 360

    return hue, sat


def _hue_in_ranges(hue, ranges):
    mask = np.zeros_like(hue, dtype=bool)
    for lo, hi in ranges:
        mask |= (hue >= lo) & (hue <= hi)
    return mask


def _largest_blob_filtered_mask(mask, min_area=MIN_BLOB_AREA_PX):
    """Zero out any connected component smaller than min_area."""
    mask_u8 = mask.astype(np.uint8)
    if mask_u8.sum() == 0:
        return mask
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    keep = np.zeros_like(mask)
    for label_id in range(1, num_labels):  # 0 is background
        area = stats[label_id, cv2.CC_STAT_AREA]
        if area >= min_area:
            keep |= (labels == label_id)
    return keep


def crop_roi(img_rgb_float, roi=ROI):
    h, w = img_rgb_float.shape[:2]
    x0 = int(roi["x_pct"] * w)
    y0 = int(roi["y_pct"] * h)
    x1 = min(w, x0 + int(roi["w_pct"] * w))
    y1 = min(h, y0 + int(roi["h_pct"] * h))
    return img_rgb_float[y0:y1, x0:x1], (x0, y0, x1, y1)


def detect(img_rgb_float, roi=ROI):
    """Returns dict with per-color pct (after blob filtering), overall
    ball_detected bool, and which color(s) triggered it."""
    crop, roi_box = crop_roi(img_rgb_float, roi)
    hue, sat = rgb_to_hue_sat(crop)

    results = {}
    detected_colors = []
    for name, rule in COLOR_RULES.items():
        raw_mask = _hue_in_ranges(hue, rule["hue_ranges"]) & (sat >= rule["sat_min"])
        filtered_mask = _largest_blob_filtered_mask(raw_mask)
        pct = float(filtered_mask.mean() * 100)
        is_hit = pct >= rule["pct_threshold"]
        results[name] = {"pct": pct, "detected": is_hit}
        if is_hit:
            detected_colors.append(name)

    return {
        "colors": results,
        "ball_detected": len(detected_colors) > 0,
        "detected_colors": detected_colors,
        "roi_box": roi_box,
    }


def calibrate_from_images(image_paths):
    """Print real hue/saturation stats from your own images. Point it at
    close-up crops of just the red ball and just the blue ball to get
    real numbers for COLOR_RULES above."""
    for path in image_paths:
        img = Image.open(path).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        hue, sat = rgb_to_hue_sat(arr)
        colored = sat > 0.12  # loose filter, just to ignore near-gray background
        if colored.sum() == 0:
            print(f"{path}: no colored pixels found (all near-gray)")
            continue
        h_vals = hue[colored]
        s_vals = sat[colored]
        print(f"{path}:")
        print(f"    hue   p10={np.percentile(h_vals,10):6.1f}  median={np.median(h_vals):6.1f}  p90={np.percentile(h_vals,90):6.1f}")
        print(f"    sat   p10={np.percentile(s_vals,10):.3f}  median={np.median(s_vals):.3f}  p90={np.percentile(s_vals,90):.3f}")


def analyze(image_path, roi=ROI):
    img = Image.open(image_path).convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return detect(arr, roi=roi)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", nargs="?", help="Path to a single image")
    parser.add_argument("--test-all", action="store_true",
                         help="Run over data/with_balls and data/without_balls, report accuracy")
    parser.add_argument("--calibrate", nargs="+", metavar="IMG",
                         help="Print hue/saturation stats for the given images (use close-up ball crops)")
    args = parser.parse_args()

    if args.calibrate:
        calibrate_from_images(args.calibrate)
        return

    if args.test_all:
        correct, total = 0, 0
        for folder, expected in [("data/with_balls", True), ("data/without_balls", False)]:
            print(f"\n=== {folder} (expected: {'ball' if expected else 'empty'}) ===")
            for path in sorted(glob.glob(f"{folder}/*.png") + glob.glob(f"{folder}/*.jpg")):
                r = analyze(path)
                ok = r["ball_detected"] == expected
                correct += ok
                total += 1
                mark = "\u2713" if ok else "\u2717 WRONG"
                colors_str = ", ".join(
                    f"{c}={r['colors'][c]['pct']:.2f}%" for c in r["colors"]
                )
                label = "+".join(r["detected_colors"]) if r["detected_colors"] else "empty"
                print(f"  {path:45s} {colors_str:28s} -> {label:10s} {mark}")
        print(f"\nAccuracy on sample set: {correct}/{total}")
        if correct < total:
            print("Tip: run --calibrate on close-up crops of the misclassified balls to")
            print("re-tune hue_ranges / sat_min / pct_threshold above.")
        return

    if not args.image:
        print("Usage: python color_rule_detector.py <image_path>  OR  --test-all  OR  --calibrate <imgs...>")
        sys.exit(1)

    r = analyze(args.image)
    if r["detected_colors"]:
        label = " + ".join(r["detected_colors"]) + " ball detected"
    else:
        label = "Empty bowl"
    detail = ", ".join(f"{c}={r['colors'][c]['pct']:.2f}%" for c in r["colors"])
    print(f"{label}  ({detail})")


if __name__ == "__main__":
    main()
