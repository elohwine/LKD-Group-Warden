export async function getCurrentLocation() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy || null
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}