"""
live_test.py
-------------
Standalone live camera test. This file and color_rule_detector.py each
contain their own copy of the detection logic below (ROI, COLOR_RULES,
rgb_to_hue_sat, blob filtering). THEY MUST BE KEPT IN SYNC BY HAND - if
you tune a threshold in color_rule_detector.py (e.g. via --calibrate
and --test-all), copy the same change here, or this live app will
quietly behave differently than what you validated offline.

When you press 's', instead of judging off a single frame (which is
where most of the "sometimes wrong" comes from - one frame with motion
blur, a flickering light, or a glare spike can flip the result), this
grabs a short burst of frames and takes a majority vote per color.

Controls:
    s  -> capture a burst and show the voted result
    q  -> quit

Usage:
    python live_test.py
    python live_test.py --camera 1        # if you have more than one camera
    python live_test.py --burst 7         # frames per capture (default 5)
"""

import argparse
import time
import pathlib

import cv2
import numpy as np

# ---------------------------------------------------------------------
# ROI (as % of image width/height)
# ---------------------------------------------------------------------
ROI = {"x_pct": 0.14, "y_pct": 0.12, "w_pct": 0.53, "h_pct": 0.56}

# ---------------------------------------------------------------------
# Per-color tuning. Hue is in degrees (0-360, standard HSV hue wheel).
# KEEP THIS BLOCK IDENTICAL TO THE ONE IN color_rule_detector.py.
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

    safe_delta = np.where(delta <= 1e-6, 1.0, delta)
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
    mask_u8 = mask.astype(np.uint8)
    if mask_u8.sum() == 0:
        return mask
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    keep = np.zeros_like(mask)
    for label_id in range(1, num_labels):
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


def bgr_frame_to_rgb_float(frame):
    return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0


def capture_and_vote(cap, n_frames=5, delay=0.04):
    """Grab n_frames in quick succession, run detect() on each, majority-vote per color."""
    votes = {}
    pct_sums = {}
    last_frame = None

    for _ in range(n_frames):
        ok, frame = cap.read()
        if not ok:
            continue
        last_frame = frame
        rgb = bgr_frame_to_rgb_float(frame)
        r = detect(rgb, roi=ROI)
        for color, info in r["colors"].items():
            votes.setdefault(color, []).append(info["detected"])
            pct_sums[color] = pct_sums.get(color, 0.0) + info["pct"]
        time.sleep(delay)

    detected_colors = []
    avg_pct = {}
    for color, vote_list in votes.items():
        avg_pct[color] = pct_sums[color] / len(vote_list)
        if sum(vote_list) > len(vote_list) / 2:
            detected_colors.append(color)

    return detected_colors, avg_pct, last_frame


def draw_result(frame, detected_colors, avg_pct):
    if detected_colors:
        label = " + ".join(detected_colors).upper() + " DETECTED"
        color = (0, 255, 0)
    else:
        label = "NO BALL"
        color = (0, 0, 255)

    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (frame.shape[1], 90), (0, 0, 0), -1)
    frame = cv2.addWeighted(overlay, 0.6, frame, 0.4, 0)

    cv2.putText(frame, label, (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.1,
                color, 3, cv2.LINE_AA)
    detail = "  ".join(f"{c}:{p:.1f}%" for c, p in avg_pct.items())
    cv2.putText(frame, detail, (15, 75), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                (255, 255, 255), 1, cv2.LINE_AA)
    return frame


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--burst", type=int, default=5,
                         help="Number of frames to vote across per capture (default 5)")
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        print(f"Could not open camera {args.camera}. Try a different --camera index.")
        return

    out_dir = pathlib.Path("captures")
    out_dir.mkdir(exist_ok=True)

    result_frame = None
    result_until = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        display = frame.copy()
        if time.time() < result_until and result_frame is not None:
            display = result_frame
        cv2.imshow("Ball Detector - press 's' to capture, 'q' to quit", display)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        elif key == ord("s"):
            detected_colors, avg_pct, last_frame = capture_and_vote(cap, n_frames=args.burst)
            if last_frame is None:
                continue
            result_frame = draw_result(last_frame.copy(), detected_colors, avg_pct)
            result_until = time.time() + 3

            filename = out_dir / f"capture_{int(time.time() * 1000)}.png"
            cv2.imwrite(str(filename), last_frame)

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
