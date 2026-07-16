export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Detection = {
  label: string;
  score: number;
  box: Box;
};

export type OcrResult = {
  text: string;
  confidence: number;
};

export type AlprPipelineResult = {
  vehicle?: Detection;
  plate?: Detection;
  ocr?: OcrResult;
  latencyMs: number;
};

export type OverlayState = {
  plateText: string;
  confidence: number;
  hasResult: boolean;
  latencyMs: number;
};

export type FramePluginInput = {
  frameSkip: number;
  minVehicleScore: number;
  minPlateScore: number;
  minOcrScore: number;
};

export type FramePluginOutput = {
  plateText?: string;
  confidence?: number;
  latencyMs?: number;
  vehicleBox?: Box;
  plateBox?: Box;
};
