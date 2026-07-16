# ALPR Native Plugin Design

This document defines the inference steps that should run in the native frame processor plugin.

## Inputs

- Frame (YUV)
- frameSkip
- minVehicleScore
- minPlateScore
- minOcrScore

## Steps per processed frame

1. Convert YUV frame to model tensor format once.
2. Run vehicle detector (YOLOv8n or YOLOv11n ONNX).
3. Select best vehicle candidate above minVehicleScore.
4. Run plate detector on selected vehicle region (or full frame fallback).
5. Select best plate box above minPlateScore.
6. Crop plate ROI.
7. Run OCR model compatible with Fast-ALPR style outputs.
8. Decode OCR logits to plate text and confidence.
9. Return minimal payload to JS.

## Return payload

- plateText
- confidence
- latencyMs
- vehicleBox
- plateBox

## Performance notes

- Keep ONNX sessions warm and reused.
- Avoid reallocating tensors per frame.
- Process every 3rd or 5th frame only.
- Keep camera preview at 30 fps.
