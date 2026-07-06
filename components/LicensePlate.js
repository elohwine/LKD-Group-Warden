import React from 'react';

export default function LicensePlate({ number = 'N/A', size = 'small' }) {
  const isLarge = size === 'large';

  return (
    <div
      style={{
        width: isLarge ? 210 : 120,
        borderRadius: 8,
        overflow: 'hidden',
        border: '2px solid #08111d',
        background: '#fff',
        boxShadow: '0 8px 18px rgba(0,0,0,0.18)'
      }}
    >
      <div style={{ background: '#1E40AF', color: '#ffd700', padding: '4px 8px', fontSize: isLarge ? 12 : 8, fontWeight: 700 }}>
        LDK
      </div>
      <div style={{ padding: isLarge ? '12px 10px' : '8px 10px', color: '#000', fontWeight: 800, fontSize: isLarge ? 24 : 12, letterSpacing: 2, textAlign: 'center' }}>
        {number}
      </div>
    </div>
  );
}