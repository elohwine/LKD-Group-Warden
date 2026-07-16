# Runtime Flow

Camera Preview at 30 fps

-> Every 5th frame

-> YOLO vehicle detector

-> YOLO plate detector

-> Crop plate ROI

-> Fast-ALPR-compatible OCR ONNX model

-> Temporal smoothing over 7 reads

-> Display plate and confidence

Expected UI output format:

ABC 1234
Confidence: 98%
