import normalizeVrm from './normalizeVrm.mjs';

function cleanValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim();
  if (!text) return null;
  if (text.toLowerCase() === 'unknown') return null;
  return text;
}

function cleanUrl(value) {
  const url = cleanValue(value);
  if (!url || typeof url !== 'string') return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

function pickFirstUrl(...candidates) {
  for (const value of candidates) {
    const url = cleanUrl(value);
    if (url) return url;
  }
  return null;
}

export function buildVehicleDetailsRecord(input, fallbackVrm = '') {
  if (!input || typeof input !== 'object') return null;

  const imageUrls = [
    cleanUrl(input.imageUrl),
    ...(Array.isArray(input.imageUrls) ? input.imageUrls.map(cleanUrl) : []),
  ].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);

  const details = {
    vrm: cleanValue(normalizeVrm(input.vrm || fallbackVrm || '')),
    make: cleanValue(input.make),
    model: cleanValue(input.model),
    color: cleanValue(input.color || input.colour),
    bodyType: cleanValue(input.bodyType),
    fuelType: cleanValue(input.fuelType),
    yearOfManufacture: cleanValue(input.yearOfManufacture),
    dateFirstRegistered: cleanValue(input.dateFirstRegistered),
    motStatus: cleanValue(input.motStatus),
    motExpiry: cleanValue(input.motExpiry),
    taxStatus: cleanValue(input.taxStatus),
    taxDueDate: cleanValue(input.taxDueDate),
    engineCapacityCc: cleanValue(input.engineCapacityCc),
    transmission: cleanValue(input.transmission),
    euroStatus: cleanValue(input.euroStatus),
    co2Emissions: cleanValue(input.co2Emissions),
    wheelplan: cleanValue(input.wheelplan),
    grossWeightKg: cleanValue(input.grossWeightKg),
    seats: cleanValue(input.seats),
    doors: cleanValue(input.doors),
    keeperChanges: cleanValue(input.keeperChanges),
    imageUrl: pickFirstUrl(input.imageUrl, imageUrls[0]),
    imageUrls,
    source: 'CARCHECK',
  };

  const hasData = Object.entries(details)
    .some(([key, value]) => key !== 'source' && value !== null && (!Array.isArray(value) || value.length > 0));

  return hasData ? details : null;
}
