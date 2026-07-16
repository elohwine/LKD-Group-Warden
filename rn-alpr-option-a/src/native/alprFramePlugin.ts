import type { Frame } from 'react-native-vision-camera';
import { VisionCameraProxy } from 'react-native-vision-camera-worklets';
import type { FramePluginInput, FramePluginOutput } from '@types/alpr';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('alprFrameProcessor');

export function runAlprFramePlugin(frame: Frame, input: FramePluginInput): FramePluginOutput | null {
  'worklet';

  if (plugin == null) {
    return null;
  }

  try {
    const output = plugin.call(frame, input) as FramePluginOutput | null;
    return output;
  } catch {
    return null;
  }
}
