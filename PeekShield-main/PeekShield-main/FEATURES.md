# PEEKSHIELD — Feature & Testing Guide
> **Panic Mode + Unified Stranger Detection (OpenCV & MediaPipe)**  
> **Version**: 1.2.0 (Simplified & Working)  
> **Last Updated**: 2026-11-03  
> **Platform**: Windows 10/11 x64 (.exe)

---

## 📁 Project Structure

```
PeakShield/
├── package.json                          # Scripts (dev, build, test:detector, test:yunet)
├── FEATURES.md                           # 📖 Complete features, tests & code locations
├── start.js                              # Clean dev launcher (strips ELECTRON_RUN_AS_NODE)
├── build.js                              # Builder script
├── .gitignore
├── python/                               # 🐍 Python Vision Engine
│   ├── models/                           # ONNX Models (YuNet Face Detector)
│   │   └── face_detection_yunet_2023mar.onnx
│   ├── vision/                           # Modular vision package
│   │   ├── __init__.py
│   │   ├── camera.py                     # DirectShow camera manager (Phase 1)
│   │   └── face_detector.py              # OpenCV Zoo YuNet multi-face detector (Phase 2)
│   ├── detector.py                       # High-performance detection daemon & IPC bridge
│   ├── test_yunet.py                     # Standalone YuNet test script
│   └── requirements.txt                  # Python dependencies
├── src/
│   ├── main.js                           # Electron main process (windows, IPC, overlays, tray, hotkeys)
│   ├── preload.js                        # Secure IPC bridge exposing Stranger Detection & Panic APIs
│   └── renderer/
│       ├── index.html                    # Streamlined 3-tab UI (Stranger Detection, Panic Mode, Settings)
│       ├── styles.css                    # Dark cyber-privacy styling & status animations
│       ├── app.js                        # Client state engine: live preview stream, status ribbon & controls
│       └── overlay.html                  # Fullscreen always-on-top blur decoy shield with auto-restore
└── dist/
    └── win-unpacked/
        └── PEEKSHIELD Panic Mode.exe     # 🚀 Standalone Windows 64-bit production executable
```

---

## 🎯 Acceptance Criteria Verification Status

| Requirement | Status | Verification & Code Evidence |
|---|---|---|
| **OpenCV + MediaPipe integrated into Stranger Detection** | ✅ PASS | Integrated directly into the main Stranger Detection tab. No separate/confusing menus. |
| **Detect another person using the webcam** | ✅ PASS | MediaPipe real-time face detection checks for 2+ people (shoulder surfers / onlookers) using OpenCV DirectShow webcam feed. |
| **Automatically blur the screen when another person appears** | ✅ PASS | `showStrangerOverlay()` activates a fullscreen always-on-top privacy shield overlay as soon as an additional person appears. |
| **Restore screen automatically when they leave** | ✅ PASS | Continuous verification detects when the extra person leaves ($\le 1$ face) and immediately calls `hideStrangerOverlay()`. |
| **Webcam processes 100% locally; zero cloud uploads** | ✅ PASS | OpenCV and MediaPipe run entirely on local CPU/GPU hardware. No video or images ever leave the PC. |
| **Visual indicator for detected face count & privacy status** | ✅ PASS | Live HUD shows face count (`Faces: 1` vs `Faces: 2+`), real-time FPS, and privacy status pill (`SAFE` vs `STRANGER DETECTED`). |
| **Camera permission error handling** | ✅ PASS | Actionable warning banner alerts user if Windows camera permission is denied or if the webcam is in use by another app. |
| **Simplified options & removed bloat** | ✅ PASS | Removed redundant face enrollment steps, duplicate sliders, and separate tabs. Single master toggle runs everything. |
| **Produces a runnable Windows .exe** | ✅ PASS | Built with `electron-builder` at `dist\win-unpacked\PEEKSHIELD Panic Mode.exe`. Tested and running cleanly. |

---

## ✅ Core Features & Testing Instructions

### Feature 1: Unified Stranger Detection (OpenCV + MediaPipe)
| Item | Detail |
|---|---|
| **What it does** | Automatically detects another person in front of your screen using OpenCV webcam capture and MediaPipe Face Detection. If a second person (onlooker / shoulder surfer) appears, it immediately blurs your screen with a fullscreen privacy shield. Restores visibility automatically when they leave. |
| **Where it lives** | Python Engine: `python/detector.py` · Process Manager & IPC: `src/main.js` (`startPythonDetector`, `set-stranger-detection`) · Bridge: `src/preload.js` · UI: `src/renderer/index.html` (Tab: `tab-stranger`) · Client Logic: `src/renderer/app.js` |
| **Privacy** | 🔒 100% On-Device / Zero Cloud Upload. |
| **How to test (Live)** | 1. Launch PEEKSHIELD (`npm run dev` or `PEEKSHIELD Panic Mode.exe`) · 2. Stay on the **👤 Stranger Detection** tab · 3. Flip the **Stranger Detection** switch to **ON** (or click `Start Detection`) · 4. Live camera preview appears showing your face with green bounding box and `🟢 SAFE (1 PERSON)` status · 5. Have a friend/colleague look into the webcam (or hold up a photo/phone) · 6. Status changes to red `STRANGER DETECTED ⚠️` and the fullscreen blur privacy shield covers the screen · 7. Have the second person step away · 8. Screen restores automatically! |

---

### Feature 2: Privacy Shield Overlay & Test Blur Trigger
| Item | Detail |
|---|---|
| **What it does** | Fullscreen always-on-top window with frosted blur, red warning pulse, auto-restore indicator, manual dismiss button, and `Esc`/`Ctrl+Shift+X` shortcuts |
| **Where it lives** | `src/main.js` (`showStrangerOverlay()`, `hideStrangerOverlay()`) · View: `src/renderer/overlay.html` |
| **How to test (Simulator)** | 1. Click **🚨 Test Blur Overlay** in the Stranger Detection tab · 2. Fullscreen privacy shield appears immediately · 3. Auto-restores in ~3.5 seconds or on clicking `Unlock` |

---

### Feature 3: Global Panic Mode (`Ctrl+Shift+X`)
| Item | Detail |
|---|---|
| **What it does** | Instant one-key manual panic button that minimizes foreground window, shows decoy, and launches Safe Target (e.g. Google.com or Notepad) |
| **Where it lives** | `src/main.js` (`togglePanic()`, `hideActiveWindow()`, `restoreWindow()`) · UI: `src/renderer/index.html` (Tab: `tab-panic`) |
| **How to test** | 1. Press **`Ctrl+Shift+X`** from any application · 2. Active window minimizes and Safe Target opens · 3. Press **`Ctrl+Shift+X`** again to restore original window |

---

### Feature 4: Essential Settings & System Tray
| Item | Detail |
|---|---|
| **What it does** | Configure Safe Target URL/app and shield blur intensity (10px - 50px). Minimizes cleanly to Windows system tray. |
| **Where it lives** | UI: `src/renderer/index.html` (Tab: `tab-settings`) · Store: `src/main.js` (`SimpleStore`) |
| **How to test** | 1. Switch to **⚙️ Settings** tab · 2. Change Safe Target or Blur slider · 3. Click **💾 Save Settings** · 4. Values persist across restarts in `%APPDATA%\peekshield-panic-mode\peekshield-config.json` |

---

## 🚀 Quick Start Commands

| Command | Action |
|---|---|
| `pip install -r python/requirements.txt` | Install Python dependencies (`opencv-python`, `mediapipe<=0.10.14`, `numpy`) |
| `npm run test:yunet` | Test OpenCV Zoo YuNet multi-face detection standalone in terminal |
| `npm run test:detector` | Test OpenCV detector standalone with native GUI preview window |
| `npm start` or `npm run dev` | Launch PEEKSHIELD in development mode (with clean environment via `start.js`) |
| `npm run build` | Compile & package production Windows `.exe` to `dist/win-unpacked/` |
| `npm run run:exe` | Launch the compiled standalone Windows 64-bit production executable |
| `& ".\dist\win-unpacked\PEEKSHIELD Panic Mode.exe"` | Double-click in Windows Explorer or run directly from PowerShell |
