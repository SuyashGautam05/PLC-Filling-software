"""
analyze_box.py

Called by main.js as: python3 analyze_box.py <image_path>

Rule-based detector. Detection pipeline:
  1. Locate the cup itself (bright/white contour) — robust to the cup
     moving around the frame.
  2. Within the cup's interior, look for actual ball-COLORED blobs, using
     PER-COLOR hue ranges + saturation floors + brightness floors +
     circularity floors (not one shared threshold set for both colors).
  3. Decide filled/empty per color by the SIZE of that color's largest
     blob relative to the cup's area — not by what fraction of the whole
     interior looks "colored".

WHY EVERYTHING IS PER-COLOR NOW (this is the fix for "blue balls
sometimes not detected even when present"): hue/saturation were already
split per color (blue's saturation floor is lower — camera auto-white-
balance desaturates blue more aggressively than red, and glossy blue
surfaces wash out further under highlights). But VAL_MIN (brightness
floor) and MIN_CIRCULARITY were still a single shared value for both
colors. That's the same mistake in a different filter: a glossy blue
ball's specular highlight can wash out part of its rim to near-white,
leaving only a partial arc/crescent of true blue in the color mask —
low circularity, same shape as the false-positive blue reflection this
filter was originally tuned to reject (~0.18). A shared 0.5 floor
rejects both the fake reflection AND a real ball's washed-out crescent.
Blue now gets its own (looser) circularity and brightness floors so a
genuine partial-blue arc still passes, while an actual thin streak
reflection still doesn't.

These hue/saturation ranges are ported from color_rule_detector.py /
live_test.py, which were calibrated against real photos via
--calibrate (not guessed). The new per-color val_min/min_circularity
values below are NOT yet calibrated against real photos — they're a
reasoned starting point (see comments on each). Use the debug log
(analyze_box.log) to see the actual circularity/brightness of blobs
that get rejected, and tune from there.

KEEP THIS FILE'S COLOR_RULES HUE/SAT NUMBERS IN SYNC WITH
color_rule_detector.py AND live_test.py BY HAND — if you recalibrate
there, copy the same hue/sat numbers here too (this file uses OpenCV's
0-179 hue / 0-255 saturation scale; the other two use degrees 0-360 /
0-1, see the conversion helper below). val_min/min_circularity/
pct_threshold are specific to this file (the other two don't have a
cup-relative blob-size or circularity concept) and don't need to be
kept in sync with them.

Output JSON (single line printed to stdout — nothing else must go to
stdout, see logging setup below):
  - fillStatus: "filled" | "empty" | "unknown" (cup not located)
  - confidence: the largest ball-blob's size as a % of the cup's area —
    NOT a probability, just the signal that drove the decision
  - redBalls / blueBalls: blob counts, informational only
  - note: explanation when the cup itself couldn't be located
"""

import sys
import os
import json
import math
import logging
import traceback
import numpy as np
import cv2

# ---------------------------------------------------------------------
# Logging. IMPORTANT: stdout is reserved for the single JSON result line
# that main.js parses — logs never go there. They go to:
#   1. analyze_box.log next to this script — persists across runs, so
#      you can open it later and see exactly why any past capture was
#      classified the way it was (percentages, cup detection, errors).
#   2. stderr — main.js already captures stderr and includes it in the
#      error message shown in the app when something goes wrong.
# ---------------------------------------------------------------------
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'analyze_box.log')

logger = logging.getLogger('analyze_box')
logger.setLevel(logging.DEBUG)
logger.propagate = False

_formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')

if not logger.handlers:
    _file_handler = logging.FileHandler(LOG_PATH, encoding='utf-8')
    _file_handler.setFormatter(_formatter)
    _file_handler.setLevel(logging.DEBUG)
    logger.addHandler(_file_handler)

    _stderr_handler = logging.StreamHandler(sys.stderr)
    _stderr_handler.setFormatter(_formatter)
    _stderr_handler.setLevel(logging.WARNING)  # only warnings/errors also echo to stderr
    logger.addHandler(_stderr_handler)

# --- Cup localization (unchanged) ---------------------------------------
CUP_HSV_LOW = (0, 0, 130)
CUP_HSV_HIGH = (180, 180, 255)
CUP_CLOSE_KERNEL = 15
CUP_ERODE_KERNEL = 21
MIN_CUP_AREA_FRACTION = 0.01  # cup must cover at least 1% of the frame

# ---------------------------------------------------------------------
# Per-color tuning. hue_ranges/sat_min are calibrated from real photos
# via color_rule_detector.py --calibrate, in the SAME units (hue degrees
# 0-360, saturation 0-1) as that file so they're easy to compare/copy —
# converted to OpenCV's 0-179 hue / 0-255 saturation/value scale below.
#
# val_min / min_circularity / pct_threshold are local to this file (see
# module docstring for why blue's are looser than red's) — NOT yet
# calibrated against real photos, treat as a starting point to tune
# using analyze_box.log.
#
# KEEP hue_ranges / sat_min IN SYNC WITH color_rule_detector.py AND
# live_test.py.
# ---------------------------------------------------------------------
COLOR_RULES_DEGREES = {
    "red": {
        "hue_ranges": [(0, 18), (345, 360)],  # red wraps around 0/360
        "sat_min": 0.28,          # lowered from 0.35 — real captures measured well above this
        "val_min": 45,            # lowered from 60 — more room for a dimmer/partially-shadowed ball
        "min_circularity": 0.35,  # lowered from 0.5 — real balls measured 0.63-0.85, fake
                                   # reflection measured ~0.18, so this still keeps ~2x margin
                                   # above the one known false-positive shape
        "pct_threshold": 2.5,     # lowered from 4.0 — real captures measured 8.3-9.0%, so this
                                   # still catches a ball that's ~2/3 occluded by the cup rim
    },
    "blue": {
        "hue_ranges": [(185, 255)],
        "sat_min": 0.14,          # lowered from 0.18 — deliberately lower than red, see module docstring
        "val_min": 25,            # lowered from 35 — washed-out/highlighted blue can read darker+duller
        "val_max": 230,           # ceiling excluding blown-out highlights — a blue-tinted lighting
                                  # cast on an EMPTY cup measured as a near-fully-saturated highlight
                                  # (brightness 255, blown out) while a real blue ball's own
                                  # brightest pixels topped out at 199. Confirmed on real captures.
        "min_circularity": 0.25,  # lowered from 0.3 — real balls measured 0.69-0.87; still
                                   # comfortably above the ~0.18 false-positive reflection shape
        "pct_threshold": 2.5,     # lowered from 4.0 — real captures measured 5.8-8.4%
    },
}

# Unchanged from before: a floor on brightness so near-black noise can't
# qualify as a "ball" regardless of hue/saturation — now per-color, see
# val_min above, instead of one shared VAL_MIN.

MIN_CIRCULARITY_DEFAULT = 0.5  # kept as a fallback constant; per-color values above are used


def _degree_hue_to_opencv(ranges_deg):
    """[(0,360) hue degree ranges] -> [(0,179) OpenCV hue ranges]."""
    return [(math.floor(lo / 2), math.ceil(hi / 2)) for lo, hi in ranges_deg]


def _build_cv_ranges():
    """Build per-color OpenCV inRange bounds, each with its own val_min
    (and optional val_max) baked in."""
    cv_rules = {}
    for name, rule in COLOR_RULES_DEGREES.items():
        hue_cv = _degree_hue_to_opencv(rule["hue_ranges"])
        sat_min_cv = round(rule["sat_min"] * 255)
        val_min_cv = rule["val_min"]
        val_max_cv = rule.get("val_max", 255)  # default: no ceiling
        ranges = [((lo, sat_min_cv, val_min_cv), (hi, 255, val_max_cv)) for lo, hi in hue_cv]
        cv_rules[name] = {
            "ranges": ranges,
            "min_circularity": rule["min_circularity"],
            "pct_threshold": rule["pct_threshold"],
        }
    return cv_rules


CV_RULES = _build_cv_ranges()

logger.debug(f"Color ranges in use: {CV_RULES}")

# Decision: largest ball-colored blob as a % of the cup's own area.
MIN_BLOB_ABS_PIXELS = 60  # lowered from 100 — real ball blobs measured 9,000-12,000px, so
                           # this still comfortably excludes single-digit-pixel noise specks

# Blue's saturation/value floors are now looser, which means it can pick
# up slightly more noise than before — this small absolute-pixel floor
# (borrowed from color_rule_detector.py's MIN_BLOB_AREA_PX) drops tiny
# stray blobs before they're even considered, independent of the
# ball_detected decision threshold above. Applied the same for both
# colors — it's a noise floor, not a color-behavior difference.
MIN_NOISE_BLOB_PX = 25


def find_cup_mask(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    white_mask = cv2.inRange(hsv, CUP_HSV_LOW, CUP_HSV_HIGH)

    kernel = np.ones((CUP_CLOSE_KERNEL, CUP_CLOSE_KERNEL), np.uint8)
    closed = cv2.morphologyEx(white_mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest = max(contours, key=cv2.contourArea)

    # A dark ball sitting near/against the cup's inner rim can locally
    # break the bright ring into a crescent instead of a full loop —
    # the ball creates a "notch" that disconnects part of the contour,
    # so the cup's own mask ends up EXCLUDING the exact spot the ball is
    # sitting in (confirmed on a real capture: a dark blue ball's pixel
    # location fell completely outside the mask, causing a 100% miss
    # even though the color/circularity rules were otherwise correct).
    #
    # A bigger closing kernel "fixes" this but is too blunt — it also
    # bridges gaps to nearby BACKGROUND objects in other shots, causing
    # the mask to balloon out into the background and reintroducing the
    # old lighting-cast false-positive (confirmed: this regressed 3 of 4
    # previously-correct empty captures when tried).
    #
    # convexHull is the surgical fix: a cup's true outer silhouette is
    # itself convex, so hulling the contour smooths over a ball-shaped
    # notch WITHOUT expanding into unrelated background — it can only
    # ever fill in the existing contour's own concave dents, not merge
    # in separate nearby regions the way a bigger closing kernel would.
    largest = cv2.convexHull(largest)

    area = cv2.contourArea(largest)
    total_pixels = img.shape[0] * img.shape[1]
    if area < total_pixels * MIN_CUP_AREA_FRACTION:
        return None

    mask = np.zeros(img.shape[:2], dtype=np.uint8)
    cv2.drawContours(mask, [largest], -1, 255, -1)
    mask = cv2.erode(mask, np.ones((CUP_ERODE_KERNEL, CUP_ERODE_KERNEL), np.uint8))
    return mask


def color_mask_for(hsv, color_name):
    ranges = CV_RULES[color_name]["ranges"]
    mask = None
    for lower, upper in ranges:
        m = cv2.inRange(hsv, lower, upper)
        mask = m if mask is None else cv2.bitwise_or(mask, m)
    return mask


def blob_candidates(mask, min_area=MIN_NOISE_BLOB_PX):
    """Returns list of (area, circularity) for every blob above min_area,
    BEFORE applying any circularity cutoff — used both for the real
    decision (filtered by the caller) and for debug logging so you can
    see exactly what got rejected and why."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        perimeter = cv2.arcLength(c, True)
        if perimeter <= 0:
            continue
        circularity = 4 * np.pi * area / (perimeter ** 2)
        candidates.append((area, circularity))
    return candidates


def analyze_color(mask_in_cup, color_name, cup_area):
    """Per-color decision: largest blob that clears BOTH this color's
    circularity floor AND the absolute/percentage size floors."""
    rule = CV_RULES[color_name]
    all_candidates = blob_candidates(mask_in_cup, min_area=MIN_NOISE_BLOB_PX)

    # Log every candidate blob (even rejected ones) so a failed blue
    # detection is diagnosable from analyze_box.log instead of a guess.
    if all_candidates:
        logger.debug(
            f"[{color_name}] candidate blobs (area, circularity): "
            + ", ".join(f"({a:.0f}, {c:.2f})" for a, c in sorted(all_candidates, reverse=True)[:5])
        )

    passing = [a for a, c in all_candidates if c >= rule["min_circularity"]]
    largest = max(passing) if passing else 0
    largest_pct = (largest / cup_area) * 100 if cup_area else 0
    detected = largest >= MIN_BLOB_ABS_PIXELS and largest_pct >= rule["pct_threshold"]

    # Count uses the SAME bar as the detection decision (circularity +
    # pct_threshold + MIN_BLOB_ABS_PIXELS), applied per-blob instead of
    # just to the largest one. This intentionally does NOT use the loose
    # MIN_NOISE_BLOB_PX/circularity floors alone — those are low enough
    # (by design, to catch an occluded/washed-out real ball) that small
    # noise specks with above-floor circularity would otherwise get
    # counted as extra "balls" while contributing nothing to fillStatus.
    count = sum(
        1 for a, c in all_candidates
        if c >= rule["min_circularity"]
        and a >= MIN_BLOB_ABS_PIXELS
        and (a / cup_area * 100 if cup_area else 0) >= rule["pct_threshold"]
    )

    return largest, largest_pct, detected, count


def analyze_fill(img):
    cup_mask = find_cup_mask(img)
    if cup_mask is None or cv2.countNonZero(cup_mask) < 200:
        logger.warning("Cup not located in this frame.")
        return None, None, None, None, "Could not locate the cup in this frame."

    cup_area = cv2.countNonZero(cup_mask)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    red_mask = cv2.bitwise_and(color_mask_for(hsv, "red"), cup_mask)
    blue_mask = cv2.bitwise_and(color_mask_for(hsv, "blue"), cup_mask)

    red_largest, red_pct, red_detected, red_count = analyze_color(red_mask, "red", cup_area)
    blue_largest, blue_pct, blue_detected, blue_count = analyze_color(blue_mask, "blue", cup_area)

    ball_detected = red_detected or blue_detected
    # Report whichever color's blob is bigger as the driving "confidence"
    # number — if neither triggered, still show the closer one so you can
    # see how near it came instead of just "0".
    largest_pct = max(red_pct, blue_pct)

    logger.debug(
        f"cup_area={cup_area} "
        f"red: largest={red_largest:.0f} pct={red_pct:.2f}% detected={red_detected} count={red_count} | "
        f"blue: largest={blue_largest:.0f} pct={blue_pct:.2f}% detected={blue_detected} count={blue_count} "
        f"-> ball_detected={ball_detected}"
    )

    return largest_pct, ball_detected, red_count, blue_count, None


# Downscale before analysis — this is a threshold/blob check, not fine
# detail work, so full webcam resolution (often 1080p+) just costs time
# for no accuracy benefit. All thresholds calibrated so far were
# percentage/ratio-based, so they hold up fine after resizing.
ANALYSIS_MAX_WIDTH = 640


def resize_for_analysis(img):
    h, w = img.shape[:2]
    if w <= ANALYSIS_MAX_WIDTH:
        return img
    scale = ANALYSIS_MAX_WIDTH / w
    return cv2.resize(img, (ANALYSIS_MAX_WIDTH, int(h * scale)), interpolation=cv2.INTER_AREA)


def main(image_path):
    logger.info(f"Analyzing: {image_path}")

    img = cv2.imread(image_path)
    if img is None:
        msg = f"Could not read image: {image_path}"
        logger.error(msg)
        print(json.dumps({"error": msg}))
        return
    img = resize_for_analysis(img)

    largest_pct, ball_detected, red_count, blue_count, note = analyze_fill(img)

    if note:
        result = {"fillStatus": "unknown", "confidence": None, "note": note}
    else:
        result = {
            "fillStatus": "filled" if ball_detected else "empty",
            "confidence": round(largest_pct, 2),
        }

    result["redBalls"] = red_count
    result["blueBalls"] = blue_count

    logger.info(f"Result: {json.dumps(result)}")
    print(json.dumps(result))


def debug_dump(image_path):
    """Human-readable diagnostics for one image, printed to stdout.
    NOT used by main.js (that contract stays a single JSON line via
    main() below) - this is for you to run by hand on a failing capture
    and see the ACTUAL numbers instead of guessing at them.

    Usage: python3 analyze_box.py --debug path/to/image.png
    """
    img = cv2.imread(image_path)
    if img is None:
        print(f"Could not read image: {image_path}")
        return
    img = resize_for_analysis(img)

    print(f"Image: {image_path}  (analyzed at {img.shape[1]}x{img.shape[0]})")

    cup_mask = find_cup_mask(img)
    if cup_mask is None:
        print("CUP NOT FOUND — nothing else below is meaningful until this is fixed.")
        print(f"  cup_hsv_range={CUP_HSV_LOW} to {CUP_HSV_HIGH}, "
              f"min_area_fraction={MIN_CUP_AREA_FRACTION}")
        return

    cup_area = cv2.countNonZero(cup_mask)
    total_pixels = img.shape[0] * img.shape[1]
    print(f"Cup found: area={cup_area}px ({cup_area/total_pixels*100:.1f}% of frame)")

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    for color_name in ("red", "blue"):
        rule = CV_RULES[color_name]
        raw_mask = color_mask_for(hsv, color_name)
        mask_in_cup = cv2.bitwise_and(raw_mask, cup_mask)
        colored_px = cv2.countNonZero(mask_in_cup)

        print(f"\n--- {color_name} ---")
        print(f"  thresholds: {rule['ranges']}  min_circularity={rule['min_circularity']}  "
              f"pct_threshold={rule['pct_threshold']}")
        print(f"  raw colored pixels in cup (before circularity filter): {colored_px} "
              f"({colored_px/cup_area*100:.2f}% of cup)")

        candidates = blob_candidates(mask_in_cup, min_area=MIN_NOISE_BLOB_PX)
        if not candidates:
            print(f"  NO blobs >= {MIN_NOISE_BLOB_PX}px found at all — this means the "
                  f"hue/sat/val ranges above are too strict for this image, not a "
                  f"circularity problem. Widen hue_ranges/lower sat_min/lower val_min.")
            continue

        candidates.sort(key=lambda x: -x[0])
        print(f"  blob candidates (area px, circularity, pct-of-cup):")
        for area, circ in candidates[:8]:
            pct = area / cup_area * 100
            passes = circ >= rule["min_circularity"]
            print(f"    area={area:7.0f}  circularity={circ:.3f}  pct={pct:5.2f}%  "
                  f"{'PASSES' if passes else 'REJECTED by circularity floor'}")

        largest, largest_pct, detected, count = analyze_color(mask_in_cup, color_name, cup_area)
        print(f"  => largest passing blob: {largest:.0f}px ({largest_pct:.2f}% of cup), "
              f"detected={detected}")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--debug":
        debug_dump(sys.argv[2])
        sys.exit(0)

    if len(sys.argv) < 2:
        logger.error("No image path provided as argument.")
        print(json.dumps({"error": "No image path provided"}))
        sys.exit(1)

    try:
        main(sys.argv[1])
    except Exception as e:
        # Catch ANYTHING unexpected (corrupt image, cv2 internal error,
        # etc.) so main.js always gets a parseable JSON line instead of a
        # bare crash with no stdout — the full traceback still goes to
        # the log file and stderr for debugging.
        logger.error(f"Unhandled exception analyzing {sys.argv[1]}: {e}")
        logger.error(traceback.format_exc())
        print(json.dumps({"error": f"Unhandled exception: {e}"}))
        sys.exit(1)