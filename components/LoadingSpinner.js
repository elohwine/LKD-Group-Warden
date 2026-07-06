import { motion } from 'framer-motion';

export default function LoadingSpinner() {
  return (
    <motion.div
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 1 }}
      style={{
        width: 32,
        height: 32,
        borderRadius: '50%',
        border: '4px solid rgba(255,255,255,0.2)',
        borderTop: '4px solid #efb84d'
      }}
    />
  );
}