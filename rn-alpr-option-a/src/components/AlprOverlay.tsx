import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { OverlayState } from '@types/alpr';

type Props = {
  state: OverlayState;
};

export function AlprOverlay({ state }: Props) {
  if (!state.hasResult) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>Scanning...</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.plate}>{state.plateText}</Text>
      <Text style={styles.meta}>Confidence: {Math.round(state.confidence * 100)}%</Text>
      <Text style={styles.meta}>Latency: {Math.round(state.latencyMs)}ms</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  label: {
    color: '#f7f7f7',
    fontSize: 14,
    fontWeight: '600',
  },
  plate: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 1,
  },
  meta: {
    color: '#e8e8e8',
    fontSize: 13,
    marginTop: 2,
  },
});
