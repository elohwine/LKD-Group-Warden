import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Worklets } from 'react-native-worklets-core';
import {
  Camera,
  useCameraPermission,
  useCameraDevice,
  useFrameOutput,
} from 'react-native-vision-camera';
import type { OverlayState } from '@types/alpr';
import { runAlprFramePlugin } from '@native/alprFramePlugin';
import { AlprOverlay } from '@components/AlprOverlay';
import { TemporalSmoother } from '@pipeline/temporalSmoother';

const FRAME_SKIP = 5;
const MIN_VEHICLE_SCORE = 0.35;
const MIN_PLATE_SCORE = 0.4;
const MIN_OCR_SCORE = 0.8;

const initialOverlay: OverlayState = {
  plateText: '',
  confidence: 0,
  hasResult: false,
  latencyMs: 0,
};

export default function App() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back', {
    physicalDevices: ['wide-angle-camera'],
  });

  const [overlay, setOverlay] = useState<OverlayState>(initialOverlay);
  const smootherRef = useRef(new TemporalSmoother(7));

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  const publishOverlay = useMemo(() => {
    return (result: { text: string; confidence: number }, latencyMs: number) => {
      const smoothed = smootherRef.current.push(result);
      setOverlay({
        plateText: smoothed.text,
        confidence: smoothed.confidence,
        hasResult: true,
        latencyMs,
      });
    };
  }, []);

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    onFrame(frame) {
      'worklet';
      try {
        const output = runAlprFramePlugin(frame, {
          frameSkip: FRAME_SKIP,
          minVehicleScore: MIN_VEHICLE_SCORE,
          minPlateScore: MIN_PLATE_SCORE,
          minOcrScore: MIN_OCR_SCORE,
        });

        if (output?.plateText && (output.confidence || 0) >= MIN_OCR_SCORE) {
          const next = {
            text: output.plateText,
            confidence: output.confidence || 0,
          };
          Worklets.runOnJS(publishOverlay)(next, output.latencyMs || 0);
        }
      } finally {
        frame.dispose();
      }
    },
  });

  if (!hasPermission || device == null) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.msg}>Camera permission required.</Text>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        isActive={true}
        device={device}
        outputs={[frameOutput]}
      />
      <AlprOverlay state={overlay} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  msg: {
    color: '#fff',
    fontSize: 16,
  },
});
