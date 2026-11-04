#!/usr/bin/env python3
"""
PEEKSHIELD — Real-Time OpenCV + YuNet + SFace Face Guardian
Features:
- Multi-face detection with OpenCV Zoo YuNet
- Deep 128-d facial embedding extraction with OpenCV Zoo SFace
- Local SQLite database supporting up to 4 trusted profiles
- Cosine similarity classification: TRUSTED, UNKNOWN, UNCERTAIN
- Screen privacy protection: blurs when an unknown/uncertain person appears
- Stdin JSON IPC for live registration and profile management
"""

import sys
import os
import json
import time
import argparse
import signal
import threading
import base64
import cv2
import numpy as np

# Suppress verbose C++ logs
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

# Ensure python directory is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vision.camera import CameraManager
from vision.face_detector import FaceDetector
from vision.face_recognizer import FaceRecognizer
from vision.gesture_recognizer import HandGestureRecognizer, GestureType
from vision.head_pose import HeadPoseEstimator
from database.db import ProfileDB


class FaceGuardian:
    def __init__(self, camera_index=0, min_confidence=0.55, emit_preview=True, show_gui=False):
        self.camera_index = camera_index
        self.min_confidence = min_confidence
        self.emit_preview = emit_preview
        self.show_gui = show_gui
        self.running = True

        # State tracking
        self.privacy_breach = False
        self.breach_consecutive = 0
        self.clear_consecutive = 0
        self.consecutive_threshold = 2  # 2 consecutive frames to confirm state

        # Incoming command queue from Electron
        self.pending_commands = []
        self.cmd_lock = threading.Lock()

        # Database, Vision & Gesture models
        self.db = ProfileDB()
        self.face_detector = FaceDetector(score_threshold=self.min_confidence)
        self.face_recognizer = FaceRecognizer(db=self.db)
        self.gesture_recognizer = HandGestureRecognizer(fist_hold_duration=0.8, gesture_cooldown=1.2)
        self.head_pose_estimator = HeadPoseEstimator()
        self.open_fist_override = False

        # Register signals & background stdin listener
        signal.signal(signal.SIGINT, self._handle_exit)
        signal.signal(signal.SIGTERM, self._handle_exit)

        t = threading.Thread(target=self._listen_stdin, daemon=True)
        t.start()

    def _listen_stdin(self):
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                if line.lower() in ("stop", "quit", "exit", "q"):
                    self.running = False
                    break
                try:
                    cmd_data = json.loads(line)
                    with self.cmd_lock:
                        self.pending_commands.append(cmd_data)
                except Exception:
                    pass
        except Exception:
            self.running = False

    def _handle_exit(self, signum, frame):
        self.running = False

    def emit_event(self, event_data):
        """Emit structured JSON event over stdout for Electron IPC."""
        try:
            line = json.dumps(event_data)
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except IOError:
            self.running = False

    def emit_error(self, message):
        """Emit error event."""
        self.emit_event({
            "type": "error",
            "message": message
        })
        sys.stderr.write(f"[PEEKSHIELD Guardian] Error: {message}\n")
        sys.stderr.flush()

    def _handle_commands(self, frame, faces):
        """Process any pending commands from Electron."""
        cmds_to_run = []
        with self.cmd_lock:
            if self.pending_commands:
                cmds_to_run = list(self.pending_commands)
                self.pending_commands.clear()

        for cmd in cmds_to_run:
            action = cmd.get("action")

            if action == "get_profiles":
                self.emit_event({
                    "type": "profiles_list",
                    "profiles": self.db.get_all_profiles()
                })

            elif action == "delete_profile":
                pid = cmd.get("profile_id")
                self.db.delete_profile(pid)
                self.face_recognizer.reload_profiles()
                self.emit_event({
                    "type": "profile_deleted",
                    "ok": True,
                    "profile_id": pid,
                    "profiles": self.db.get_all_profiles()
                })

            elif action == "register_sample":
                name = cmd.get("name", "").strip()
                if not name:
                    self.emit_event({
                        "type": "register_status",
                        "ok": False,
                        "error": "Profile name is required."
                    })
                    continue

                if len(faces) != 1:
                    self.emit_event({
                        "type": "register_status",
                        "ok": False,
                        "error": f"Please ensure exactly ONE face is in view (detected {len(faces)})."
                    })
                    continue

                # Check if profile already exists or create new
                existing_profiles = self.db.get_all_profiles()
                target_pid = None
                for p in existing_profiles:
                    if p["name"].lower() == name.lower():
                        target_pid = p["id"]
                        break

                if target_pid is None:
                    if not self.db.can_register_new():
                        self.emit_event({
                            "type": "register_status",
                            "ok": False,
                            "error": f"Maximum limit of {self.db.MAX_PROFILES} trusted profiles reached."
                        })
                        continue
                    try:
                        target_pid = self.db.add_profile(name)
                    except Exception as e:
                        self.emit_event({
                            "type": "register_status",
                            "ok": False,
                            "error": str(e)
                        })
                        continue

                # Extract SFace embedding from current frame
                emb = self.face_recognizer.extract_embedding(frame, faces[0]["raw"])
                if emb is None:
                    self.emit_event({
                        "type": "register_status",
                        "ok": False,
                        "error": "Failed to extract facial features. Adjust lighting and face the camera directly."
                    })
                    continue

                self.db.add_sample(target_pid, emb)
                self.face_recognizer.reload_profiles()

                # Get updated sample count
                updated_profiles = self.db.get_all_profiles()
                sample_count = 0
                for p in updated_profiles:
                    if p["id"] == target_pid:
                        sample_count = p["sample_count"]

                self.emit_event({
                    "type": "register_status",
                    "ok": True,
                    "profile_id": target_pid,
                    "name": name,
                    "sample_count": sample_count,
                    "profiles": updated_profiles,
                    "message": f"Sample #{sample_count} registered for '{name}'."
                })

            elif action == "set_thresholds":
                trusted = cmd.get("trusted")
                uncertain = cmd.get("uncertain")
                self.face_recognizer.set_thresholds(trusted=trusted, uncertain=uncertain)
                self.emit_event({
                    "type": "thresholds_updated",
                    "trusted": self.face_recognizer.trusted_threshold,
                    "uncertain": self.face_recognizer.uncertain_threshold
                })

    def run(self):
        """Main detection and recognition loop."""
        camera = CameraManager(self.camera_index, width=640, height=480)
        ok, msg = camera.start()
        if not ok:
            self.emit_error(msg)
            return 1

        self.emit_event({
            "type": "ready",
            "message": f"PeekShield Vision Engine active ({camera.actual_width}x{camera.actual_height}).",
            "profiles": self.db.get_all_profiles()
        })

        fps_timer = time.time()
        frame_counter = 0
        current_fps = 0.0
        last_preview_time = 0.0

        try:
            while self.running:
                ret, frame = camera.read_frame(mirror=True)
                if not ret or frame is None:
                    self.emit_error("Failed to read webcam frame. Device disconnected or busy.")
                    time.sleep(0.4)
                    continue

                # 1. Detect all faces via OpenCV Zoo YuNet
                faces = self.face_detector.detect(frame)

                # 2. Hand Gesture Recognition (Closed Fist, Open Palm, Thumbs Up)
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                gesture_info = self.gesture_recognizer.process(rgb_frame)

                # 3. Handle any interactive IPC commands (register, delete profile, etc.)
                self._handle_commands(frame, faces)

                # 4. Handle any triggered gesture actions
                action_triggered = gesture_info.get("action_triggered")
                if action_triggered == "PANIC_TRIGGERED":
                    self.emit_event({
                        "type": "gesture_action",
                        "action": "panic_activate",
                        "gesture": "CLOSED_FIST",
                        "message": "Closed fist detected! Panic Privacy Mode ACTIVATED."
                    })
                elif action_triggered == "OPEN_PALM_TRIGGERED":
                    self.emit_event({
                        "type": "gesture_action",
                        "action": "toggle_privacy",
                        "gesture": "OPEN_PALM",
                        "message": "Open palm gesture detected."
                    })
                elif action_triggered == "THUMBS_UP_TRIGGERED":
                    self.emit_event({
                        "type": "gesture_action",
                        "action": "pause_monitoring",
                        "gesture": "THUMBS_UP",
                        "message": "Thumbs up gesture detected. Monitoring paused."
                    })

                # 5. Classify faces with OpenCV Zoo SFace (TRUSTED, UNKNOWN, UNCERTAIN)
                classified_faces = self.face_recognizer.process_frame_faces(frame, faces)
                face_count = len(classified_faces)

                # 6. Estimate 3D Head Orientation & Screen-Facing Direction
                for f in classified_faces:
                    raw_face = f.get("raw")
                    if raw_face is not None and len(raw_face) >= 14:
                        landmarks = [
                            (int(raw_face[4]), int(raw_face[5])),
                            (int(raw_face[6]), int(raw_face[7])),
                            (int(raw_face[8]), int(raw_face[9])),
                            (int(raw_face[10]), int(raw_face[11])),
                            (int(raw_face[12]), int(raw_face[13]))
                        ]
                        f["pose"] = self.head_pose_estimator.estimate_pose(
                            landmarks, camera.actual_width, camera.actual_height
                        )
                    else:
                        f["pose"] = None

                trusted_count = sum(1 for f in classified_faces if f["status"] == "TRUSTED")
                unknown_count = sum(1 for f in classified_faces if f["status"] == "UNKNOWN")
                uncertain_count = sum(1 for f in classified_faces if f["status"] == "UNCERTAIN")
                facing_count = sum(1 for f in classified_faces if f.get("pose") and f["pose"].get("screen_facing"))
                stranger_facing_count = sum(1 for f in classified_faces if f["status"] != "TRUSTED" and f.get("pose") and f["pose"].get("screen_facing"))

                current_gesture = gesture_info.get("gesture", "NONE")
                has_enrolled_profiles = len(self.face_recognizer.cached_profiles) > 0
                is_trusted_present = (trusted_count > 0 or (not has_enrolled_profiles and face_count > 0))

                # If trusted person triggers or shows open palm/fist, enable viewing override
                if action_triggered == "OPEN_PALM_TRIGGERED":
                    if is_trusted_present:
                        self.open_fist_override = True
                elif action_triggered == "PANIC_TRIGGERED" or current_gesture == "CLOSED_FIST":
                    self.open_fist_override = False
                elif has_enrolled_profiles and trusted_count == 0:
                    self.open_fist_override = False

                open_fist_active = is_trusted_present and (current_gesture == "OPEN_PALM" or self.open_fist_override)

                # FPS calculation
                frame_counter += 1
                now = time.time()
                if now - fps_timer >= 1.0:
                    current_fps = round(frame_counter / (now - fps_timer), 1)
                    frame_counter = 0
                    fps_timer = now

                # ── Privacy Decision Logic ──
                # If trusted person opens fist: NO BLURRING no matter how many untrusted persons are there
                # Otherwise: breach if trusted person leaves (trusted_count == 0) OR if stranger/uncertain appears/peeps
                stranger_peeping = (unknown_count > 0 or uncertain_count > 0 or (not has_enrolled_profiles and face_count >= 2))

                if open_fist_active:
                    is_breach_condition = False
                elif has_enrolled_profiles:
                    is_breach_condition = (trusted_count == 0 or stranger_peeping)
                else:
                    is_breach_condition = stranger_peeping

                # Temporal confirmation (2 consecutive frames)
                if is_breach_condition:
                    self.breach_consecutive += 1
                    self.clear_consecutive = 0
                    if self.breach_consecutive >= self.consecutive_threshold:
                        if not self.privacy_breach:
                            self.privacy_breach = True
                            if has_enrolled_profiles and trusted_count == 0:
                                reason_msg = "Trusted person left the screen! Screen blurred."
                            elif stranger_facing_count > 0:
                                reason_msg = f"Stranger peeping into screen detected ({unknown_count} stranger(s))! Screen blurred."
                            else:
                                reason_msg = f"Stranger/Uncertain face detected near screen ({face_count} in view)! Screen blurred."
                            self.emit_event({
                                "type": "status",
                                "face_count": face_count,
                                "trusted_count": trusted_count,
                                "unknown_count": unknown_count,
                                "uncertain_count": uncertain_count,
                                "stranger_facing_count": stranger_facing_count,
                                "has_enrolled_profiles": has_enrolled_profiles,
                                "open_fist_override": open_fist_active,
                                "privacy_breach": True,
                                "status": "ALERT",
                                "fps": current_fps,
                                "message": reason_msg
                            })
                else:
                    self.clear_consecutive += 1
                    self.breach_consecutive = 0
                    if self.clear_consecutive >= self.consecutive_threshold:
                        if self.privacy_breach:
                            self.privacy_breach = False
                            if open_fist_active:
                                restore_msg = "Open fist override active (trusted person authorized viewing). Screen unblurred."
                            else:
                                restore_msg = "Privacy safe. Screen restored."
                            self.emit_event({
                                "type": "status",
                                "face_count": face_count,
                                "trusted_count": trusted_count,
                                "unknown_count": unknown_count,
                                "uncertain_count": uncertain_count,
                                "has_enrolled_profiles": has_enrolled_profiles,
                                "open_fist_override": open_fist_active,
                                "privacy_breach": False,
                                "status": "SAFE" if (trusted_count > 0 or face_count == 1) else "IDLE",
                                "fps": current_fps,
                                "message": restore_msg
                            })

                # ── Draw Multi-Face Bounding Boxes, Head Pose Rays & Hand Skeleton Annotations ──
                self.face_recognizer.draw_classified_faces(frame, classified_faces)
                for f in classified_faces:
                    if f.get("pose"):
                        self.head_pose_estimator.draw_pose(frame, f["pose"], f["bbox"])
                self.gesture_recognizer.draw_annotations(frame, gesture_info)

                # ── Stream base64 Preview Image to Electron (~12 FPS) ──
                if self.emit_preview and (now - last_preview_time >= 0.08):
                    last_preview_time = now
                    try:
                        preview_small = cv2.resize(frame, (400, 300))
                        _, buffer = cv2.imencode(".jpg", preview_small, [cv2.IMWRITE_JPEG_QUALITY, 55])
                        b64_image = "data:image/jpeg;base64," + base64.b64encode(buffer).decode("ascii")
                        self.emit_event({
                            "type": "frame",
                            "image": b64_image,
                            "face_count": face_count,
                            "trusted_count": trusted_count,
                            "unknown_count": unknown_count,
                            "uncertain_count": uncertain_count,
                            "facing_count": facing_count,
                            "stranger_facing_count": stranger_facing_count,
                            "has_enrolled_profiles": has_enrolled_profiles,
                            "open_fist_override": open_fist_active,
                            "gesture": gesture_info.get("gesture", "NONE"),
                            "fist_progress": gesture_info.get("fist_progress", 0.0),
                            "privacy_breach": self.privacy_breach,
                            "status": "ALERT" if self.privacy_breach else ("SAFE" if (trusted_count > 0 or (not has_enrolled_profiles and face_count == 1)) else "IDLE"),
                            "fps": current_fps
                        })
                    except Exception:
                        pass

                # Native OpenCV GUI window if requested
                if self.show_gui:
                    cv2.imshow("PEEKSHIELD — Live Face Recognition", frame)
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord('q') or key == 27:
                        break

        finally:
            camera.release()
            self.gesture_recognizer.close()
            if self.show_gui:
                cv2.destroyAllWindows()
            self.emit_event({
                "type": "stopped",
                "message": "Face Guardian stopped."
            })

        return 0


def main():
    parser = argparse.ArgumentParser(description="PEEKSHIELD Face Guardian")
    parser.add_argument("--camera", type=int, default=0, help="Webcam device index (default: 0)")
    parser.add_argument("--confidence", type=float, default=0.55, help="Confidence threshold (default: 0.55)")
    parser.add_argument("--json", action="store_true", default=True, help="Emit JSON events over stdout")
    parser.add_argument("--no-preview", action="store_true", help="Do not stream base64 preview frames")
    parser.add_argument("--gui", action="store_true", help="Show native OpenCV preview window")
    parser.add_argument("--standalone", action="store_true", help="Run standalone with native GUI")

    args, _ = parser.parse_known_args()

    show_gui = args.gui or args.standalone
    guardian = FaceGuardian(
        camera_index=args.camera,
        min_confidence=args.confidence,
        emit_preview=not args.no_preview,
        show_gui=show_gui
    )
    sys.exit(guardian.run())


if __name__ == "__main__":
    main()
