"""
live_test.py
-------------
Simple camera test: shows a live preview, and when you press 's' it
captures the current frame, checks it against the colour rule, and
shows the result ("BALL DETECTED" / "NO BALL") directly on the image
window - nothing printed to the terminal.

Uses the same fixed ROI/thresholds as color_rule_detector.py.

Controls:
    s  -> capture current frame and show result
    q  -> quit

Usage:
    python live_test.py
    python live_test.py --camera 1   # if you have more than one camera
"""

import argparse
import time
import pathlib

import cv2
import numpy as np

# Same defaults as color_rule_detector.py - edit these if you calibrate later
ROI = {"x_pct": 0.14, "y_pct": 0.12, "w_pct": 0.53, "h_pct": 0.56}
SAT_THRESHOLD = 0.45
PCT_THRESHOLD = 9.0


def check_ball(frame):
    h, w = frame.shape[:2]
    x0, y0 = int(ROI["x_pct"] * w), int(ROI["y_pct"] * h)
    x1, y1 = min(w, x0 + int(ROI["w_pct"] * w)), min(h, y0 + int(ROI["h_pct"] * h))

    roi = frame[y0:y1, x0:x1]
    if roi.size == 0:
        return False, 0.0

    roi_rgb = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    maxc = roi_rgb.max(axis=-1)
    minc = roi_rgb.min(axis=-1)
    sat = np.where(maxc == 0, 0, (maxc - minc) / (maxc + 1e-6))
    colored_pct = float((sat > SAT_THRESHOLD).mean() * 100)

    return colored_pct >= PCT_THRESHOLD, colored_pct


def draw_result(frame, ball_detected, colored_pct):
    label = "BALL DETECTED" if ball_detected else "NO BALL"
    color = (0, 255, 0) if ball_detected else (0, 0, 255)

    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (frame.shape[1], 70), (0, 0, 0), -1)
    frame = cv2.addWeighted(overlay, 0.6, frame, 0.4, 0)

    cv2.putText(frame, label, (15, 45), cv2.FONT_HERSHEY_SIMPLEX, 1.2,
                color, 3, cv2.LINE_AA)
    return frame


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", type=int, default=0)
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        print(f"Could not open camera {args.camera}. Try a different --camera index.")
        return

    out_dir = pathlib.Path("captures")
    out_dir.mkdir(exist_ok=True)

    result_frame = None
    result_until = 0  # timestamp until which we keep showing the result

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
            ball_detected, colored_pct = check_ball(frame)
            result_frame = draw_result(frame.copy(), ball_detected, colored_pct)
            result_until = time.time() + 3  # hold the result on screen for 3 seconds

            filename = out_dir / f"capture_{int(time.time() * 1000)}.png"
            cv2.imwrite(str(filename), frame)

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()