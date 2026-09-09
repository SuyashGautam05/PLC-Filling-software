"""
capture_frames.py
-------------------
Grabs frames from a camera connected to this PC and saves them as
test images, so you can build up data/with_balls and
data/without_balls, or just spot-check the colour rule on real
captures without opening the browser.

Controls (while the preview window is focused):
    s  -> save current frame
    q  -> quit

Usage:
    python capture_frames.py                       # camera 0, saves to captures/
    python capture_frames.py --camera 1             # pick a different camera index
    python capture_frames.py --out data/with_balls  # save straight into a class folder
"""

import argparse
import time
import pathlib

import cv2


def list_available_cameras(max_index=5):
    available = []
    for i in range(max_index):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            available.append(i)
        cap.release()
    return available


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", type=int, default=0,
                         help="Camera index (0 is usually the default/first camera)")
    parser.add_argument("--out", type=str, default="captures",
                         help="Folder to save captured frames into")
    parser.add_argument("--list", action="store_true",
                         help="List available camera indices and exit")
    args = parser.parse_args()

    if args.list:
        cams = list_available_cameras()
        print(f"Available camera indices: {cams}" if cams else "No cameras found.")
        return

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        print(f"ERROR: could not open camera index {args.camera}. "
              f"Try `python capture_frames.py --list` to see available indices.")
        return

    print("Press 's' to save a frame, 'q' to quit.")
    saved = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            print("ERROR: failed to read frame from camera.")
            break

        cv2.imshow("Camera preview - press 's' to save, 'q' to quit", frame)
        key = cv2.waitKey(1) & 0xFF

        if key == ord("s"):
            filename = out_dir / f"capture_{int(time.time() * 1000)}.png"
            cv2.imwrite(str(filename), frame)
            saved += 1
            print(f"Saved {filename} ({saved} total)")
        elif key == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()
    print(f"Done. Saved {saved} frame(s) to {out_dir}/")


if __name__ == "__main__":
    main()