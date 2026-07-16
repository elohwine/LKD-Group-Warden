# Option A: React Native ALPR Pipeline

This folder contains a React Native implementation scaffold for the pipeline you requested:

- react-native-vision-camera
- ONNX Runtime Mobile
- YOLOv8n or YOLOv11n
- Fast-ALPR-compatible OCR model path
- 30 fps preview with frame skipping

## Research-backed decisions

1. VisionCamera supports realtime frame processing via frame outputs/worklets and explicitly documents performance constraints around pixel format, frame disposal, and fps.
2. ONNX Runtime React Native supports loading ONNX models directly and running inference on Android/iOS.
3. Fast-ALPR is primarily a Python framework using ONNX models under the hood. In React Native, the practical route is to run equivalent detector and OCR ONNX models directly via onnxruntime-react-native.
4. Fast-ALPR itself is not a direct React Native package, so this scaffold mirrors its detector + OCR behavior with mobile-native inference.

## Target runtime flow

Camera Preview (30 fps)

-> Every 3rd or 5th frame

-> YOLO vehicle detector

-> YOLO plate detector

-> Crop plate ROI

-> OCR model (Fast-ALPR-compatible)

-> Temporal smoothing

-> Display plate and confidence

Example output:

ABC1234
Confidence: 98%

## Folder map

- App.tsx: Camera view + frame output + UI overlay glue
- src/native/alprFramePlugin.ts: JS bridge to native frame processor plugin
- src/pipeline/temporalSmoother.ts: de-jitter OCR results over multiple frames
- src/types/alpr.ts: shared types
- src/components/AlprOverlay.tsx: plate/confidence HUD
- models/: place ONNX model files

## Why a native frame plugin is required

Running two detectors + OCR at near realtime from plain JS over large frame buffers is not practical on mobile. VisionCamera is designed to call native frame plugins from worklet context for this exact reason.

So this scaffold is split into:

1. Worklet callback in JS
2. Native plugin for inference and crop pipeline
3. JS overlay update only for final outputs

## Model guidance

Put models in models/:

- vehicle_yolov8n.onnx or vehicle_yolov11n.onnx
- plate_yolov8n.onnx or plate_yolov11n.onnx
- fast_alpr_ocr.onnx

Use quantized variants where accuracy allows to reduce latency and APK size.

## Install commands

From this folder:

npm install

Then platform setup:

- add camera permissions in AndroidManifest.xml and Info.plist
- run pod install for iOS
- run Android/iOS build from React Native CLI

## Performance baseline

- Preview fps: 30
- Frame skip: 5 (start), move to 3 on stronger devices
- Pixel format: yuv
- Confidence thresholds:
  - vehicle >= 0.35
  - plate >= 0.40
  - OCR >= 0.80
- Temporal smoothing window: 7 reads

## Next required implementation steps

1. Implement native plugin alprFrameProcessor for Android/iOS.
2. Load ONNX sessions once at startup, not per frame.
3. Preprocess with resize + normalize exactly matching model training.
4. Return only minimal result payload to JS: plateText, confidence, latency, optional boxes.
5. Add profiling per stage: detector1, detector2, OCR.
