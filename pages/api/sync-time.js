/**
 * API endpoint to get current server time.
 * Used by client to correct device clock drift during image capture.
 */
export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Return current server time as ISO string
  const serverTime = new Date().toISOString();
  
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ timestamp: serverTime });
}
