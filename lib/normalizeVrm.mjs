export function normalizeVrm(v) {
  if (!v && v !== 0) return '';
  try {
    return String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  } catch (e) {
    return '';
  }
}

export default normalizeVrm;
