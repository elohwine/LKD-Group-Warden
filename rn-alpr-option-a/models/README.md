# Models

Put model files in this folder for on-device inference:

- vehicle_yolov8n.onnx or vehicle_yolov11n.onnx
- plate_yolov8n.onnx or plate_yolov11n.onnx
- fast_alpr_ocr.onnx

Notes:
- The OCR model is intended to mirror Fast-ALPR style OCR output in ONNX form.
- Keep model input size and preprocessing metadata documented for each file.
- For Android APK size control, use quantized models where possible.
