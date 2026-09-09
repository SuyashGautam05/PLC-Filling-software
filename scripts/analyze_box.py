"""
analyze_box.py

Called by main.js as: python3 analyze_box.py <image_path>

Rule-based detector. Detection pipeline:
  1. Locate the cup itself (bright/white contour), same as before — this
     part already proved robust to the cup moving around the frame.
  2. Within the cup's interior, look for actual ball-COLORED blobs (tight
     red/blue hue ranges with a HIGH saturation floor), not just "is
     anything here saturated".
  3. Decide filled/empty by the SIZE of the largest such blob relative to
     the cup's area — not by what fraction of the whole interior looks
     "colored".

Why the switch from a whole-ROI saturation percentage: a colored/tinted
light source (e.g. a monitor's blue glow) raises saturation UNIFORMLY
across an entirely empty white cup — every pixel gets a bit of that tint,
which looks identical to "some pixels are colored" under a percentage
threshold, causing a false "filled" on a genuinely empty cup. A real ball
is a solid, concentrated blob of a specific hue; ambient lighting tint is
spread thin across everything and rarely forms a real blob at all. Blob
SIZE separates these cleanly where overall percentage did not.

Calibrated against 6 real captures (3 filled, 3 empty — including two
that broke the earlier percentage-based approach under different lighting
casts): empty cases topped out with a largest blob at 2.5% of the cup
area; filled cases started at 6.5%. BALL_BLOB_PCT_THRESHOLD sits roughly
in the middle of that gap with margin on both sides.

Output JSON:
  - fillStatus: "filled" | "empty" | "unknown" (cup not located)
  - confidence: the largest ball-blob's size as a % of the cup's area —
    NOT a probability, just the signal that drove the decision
  - redBalls / blueBalls: blob counts using the same tight color ranges,
    informational only
  - note: explanation when the cup itself couldn't be located
"""

import sys
import json
import numpy as np
import cv2

# --- Cup localization (unchanged from the position-independent fix) ----
CUP_HSV_LOW = (0, 0, 130)
CUP_HSV_HIGH = (180, 180, 255)
CUP_CLOSE_KERNEL = 15
CUP_ERODE_KERNEL = 21
MIN_CUP_AREA_FRACTION = 0.01  # cup must cover at least 1% of the frame

# --- Ball color detection: tight hue + HIGH saturation floor so a mild
# lighting tint (saturation usually stays well under this) can't qualify,
# only an actually-saturated colored object like a ball. ------------------
RED_RANGES = [((0, 150, 60), (10, 255, 255)), ((160, 150, 60), (180, 255, 255))]
BLUE_RANGE = ((100, 150, 60), (130, 255, 255))

# Decision: largest ball-colored blob as a % of the cup's own area.
BALL_BLOB_PCT_THRESHOLD = 4.0
MIN_BLOB_ABS_PIXELS = 100  # ignore specks even if % looks high on a tiny cup

# A real ball is round; a specular reflection/lighting hotspot that
# happens to be saturated is usually an irregular streak or crescent, not
# round at all. Circularity = 4*pi*area/perimeter^2 (1.0 = perfect
# circle). Measured: real balls ~0.86-0.87, a false-positive blue
# reflection off a monitor/light in an empty cup measured 0.18 — huge
# margin, so this threshold sits safely in between.
MIN_CIRCULARITY = 0.5


def find_cup_mask(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    white_mask = cv2.inRange(hsv, CUP_HSV_LOW, CUP_HSV_HIGH)

    kernel = np.ones((CUP_CLOSE_KERNEL, CUP_CLOSE_KERNEL), np.uint8)
    closed = cv2.morphologyEx(white_mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)
    total_pixels = img.shape[0] * img.shape[1]
    if area < total_pixels * MIN_CUP_AREA_FRACTION:
        return None

    mask = np.zeros(img.shape[:2], dtype=np.uint8)
    cv2.drawContours(mask, [largest], -1, 255, -1)
    mask = cv2.erode(mask, np.ones((CUP_ERODE_KERNEL, CUP_ERODE_KERNEL), np.uint8))
    return mask


def ball_color_mask(hsv):
    red = cv2.bitwise_or(
        cv2.inRange(hsv, RED_RANGES[0][0], RED_RANGES[0][1]),
        cv2.inRange(hsv, RED_RANGES[1][0], RED_RANGES[1][1]),
    )
    blue = cv2.inRange(hsv, BLUE_RANGE[0], BLUE_RANGE[1])
    return red, blue


def blob_areas(mask, min_area=1):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return [cv2.contourArea(c) for c in contours if cv2.contourArea(c) >= min_area]


def circular_blob_areas(mask, min_area=1, min_circularity=MIN_CIRCULARITY):
    """Like blob_areas, but only counts blobs round enough to plausibly be
    a ball — filters out irregular reflections/hotspots that happen to be
    saturated but aren't ball-shaped at all."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    areas = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        perimeter = cv2.arcLength(c, True)
        if perimeter <= 0:
            continue
        circularity = 4 * np.pi * area / (perimeter ** 2)
        if circularity >= min_circularity:
            areas.append(area)
    return areas


def analyze_fill(img):
    cup_mask = find_cup_mask(img)
    if cup_mask is None or cv2.countNonZero(cup_mask) < 200:
        return None, None, None, None, "Could not locate the cup in this frame."

    cup_area = cv2.countNonZero(cup_mask)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    red_mask, blue_mask = ball_color_mask(hsv)
    red_mask = cv2.bitwise_and(red_mask, cup_mask)
    blue_mask = cv2.bitwise_and(blue_mask, cup_mask)
    combined_mask = cv2.bitwise_or(red_mask, blue_mask)

    all_blobs = circular_blob_areas(combined_mask, min_area=1)
    largest_blob = max(all_blobs) if all_blobs else 0
    largest_pct = (largest_blob / cup_area) * 100 if cup_area else 0

    ball_detected = largest_blob >= MIN_BLOB_ABS_PIXELS and largest_pct >= BALL_BLOB_PCT_THRESHOLD

    red_count = len(circular_blob_areas(red_mask, min_area=MIN_BLOB_ABS_PIXELS))
    blue_count = len(circular_blob_areas(blue_mask, min_area=MIN_BLOB_ABS_PIXELS))

    return largest_pct, ball_detected, red_count, blue_count, None


def main(image_path):
    img = cv2.imread(image_path)
    if img is None:
        print(json.dumps({"error": f"Could not read image: {image_path}"}))
        return

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

    print(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No image path provided"}))
        sys.exit(1)
    main(sys.argv[1])