import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { fetchJson } from '../lib/api';
import { clearSession, loadSession, saveSession, saveStoredSiteId } from '../lib/session';
import { signOutFromWardenApp, getStoredToken } from '../lib/auth';
import { getContraventionOptions } from '../lib/contraventions';
import { getCurrentLocation } from '../lib/geo';
import { buildApiUrl } from '../lib/api';
import { createQueueItem, deleteQueueItem, listQueueItems, saveQueueItem, updateQueueItem } from '../lib/queue';
import AppShell from '../components/AppShell';
import LoadingSpinner from '../components/LoadingSpinner.js';
import LicensePlate from '../components/LicensePlate.js';
import BreachStepper from '../components/BreachStepper';

function formatCountdown(targetIso) {
  const diff = new Date(targetIso).getTime() - Date.now();
  if (Number.isNaN(diff)) return '00:00';
  if (diff <= 0) return '00:00';
  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function toObjectUrlList(files) {
  return files.map((file) => URL.createObjectURL(file));
}

function normalizeVrm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildEvidenceFrame(imageUrl, timestamp) {
  if (!imageUrl) return null;
  return {
    imageUrl,
    vehicleImage: imageUrl,
    plateImage: imageUrl,
    timestamp: timestamp || null,
  };
}

function collectImageUrlsFromValue(root) {
  const found = [];
  const visited = new Set();
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current === 'string') {
      const candidate = current.trim();
      if (/^https?:\/\//i.test(candidate)) {
        found.push(candidate);
      }
      continue;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (typeof current === 'object') {
      if (visited.has(current)) continue;
      visited.add(current);

      for (const [key, value] of Object.entries(current)) {
        if (typeof value === 'string') {
          const candidate = value.trim();
          if (/^https?:\/\//i.test(candidate) && /(image|photo|thumb|url|img|link|uri|href)/i.test(key)) {
            found.push(candidate);
          }
          continue;
        }
        queue.push(value);
      }
    }
  }

  return found
    .filter((url) => !/\/missing/i.test(url))
    .filter((url, index, all) => all.indexOf(url) === index);
}

function diffMinutes(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const diffMs = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Math.round(diffMs / 60000);
}

function getEvidencePhaseCounts(files) {
  const safeFiles = Array.isArray(files) ? files : [];
  const entryCount = safeFiles.filter((file) => file?.phase === 'entry').length;
  const closingCount = safeFiles.filter((file) => file?.phase === 'closing').length;
  return { entryCount, closingCount };
}

function getBreachLifecycle(item) {
  const status = String(item?.status || '').toLowerCase();
  const converted = Boolean(item?.payload?.convertedToPcn) || item?.payload?.breachLifecycle === 'CONVERTED_TO_PCN';
  const { entryCount, closingCount } = getEvidencePhaseCounts(item?.files);

  if (converted) {
    return { code: 'CONVERTED', label: 'Converted to PCN', syncable: false };
  }

  if (status === 'syncing') {
    return { code: 'SYNCING', label: 'Syncing', syncable: false };
  }
  if (status === 'failed') {
    return { code: 'FAILED', label: 'Failed sync', syncable: true };
  }
  if (status === 'synced' || status === 'submitted') {
    return { code: 'SUBMITTED', label: 'Submitted', syncable: false };
  }
  if (entryCount > 0 && closingCount === 0) {
    return { code: 'DRAFT_OPEN', label: 'Open draft', syncable: false };
  }
  if (entryCount > 0 && closingCount > 0) {
    return { code: 'READY', label: 'Ready to submit', syncable: true };
  }
  return { code: 'INCOMPLETE', label: 'Incomplete draft', syncable: false };
}

function normalizeVehicleLookup(result, fallbackVrm) {
  if (!result) return null;

  const normalize = (value) => {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (!str || str.toLowerCase() === 'unknown') return null;
    return str;
  };

  const pickValid = (...candidates) => {
    for (const value of candidates) {
      const normalized = normalize(value);
      if (normalized) return normalized;
    }
    return null;
  };

  const raw = result?.raw || result || {};
  const root = result?.response || result?.data || result || {};
  const results = raw?.results || raw?.Results || {};
  const rootResults = root?.results || root?.Results || {};
  const vehicleDetails = results?.vehicleDetails || results?.VehicleDetails || result?.vehicleDetails || result?.vehicle || result?.data || {};
  const ident = vehicleDetails?.vehicleIdentification || vehicleDetails?.VehicleIdentification || vehicleDetails?.identification || {};
  const history = vehicleDetails?.vehicleHistory || vehicleDetails?.VehicleHistory || vehicleDetails?.history || {};
  const status = vehicleDetails?.vehicleStatus || vehicleDetails?.VehicleStatus || vehicleDetails?.status || {};
  const registration = vehicleDetails?.vehicleRegistration || vehicleDetails?.VehicleRegistration || vehicleDetails?.registration || {};
  const description = vehicleDetails?.vehicleDescription || vehicleDetails?.VehicleDescription || vehicleDetails?.description || {};
  const colourDetails = history?.colourDetails || history?.ColourDetails || {};
  const modelDetails = results?.modelDetails || results?.ModelDetails || {};
  const modelIdent = modelDetails?.modelIdentification || modelDetails?.ModelIdentification || {};
  const modelDescription = modelDetails?.modelDescription || modelDetails?.ModelDescription || {};
  const imageDetails = results?.vehicleImageDetails || results?.VehicleImageDetails || {};
  const imageList = imageDetails?.vehicleImageList || imageDetails?.VehicleImageList || [];
  const firstImage = imageList[0] || {};
  const technical = vehicleDetails?.dvlaTechnicalDetails || vehicleDetails?.DvlaTechnicalDetails || vehicleDetails?.technicalDetails || {};
  const mot = vehicleDetails?.mot || result?.mot || {};
  const tax = vehicleDetails?.tax || result?.tax || {};
  const extractedImageUrls = collectImageUrlsFromValue([
    result?.imageUrl,
    result?.vehicleImage,
    result?.vehicleImageUrl,
    result?.imageUrls,
    result?.images,
    result?.vehicleImages,
    result?.photos,
    root?.imageUrl,
    root?.imageUrls,
    root?.images,
    root?.vehicleImages,
    root?.photos,
    raw?.imageUrl,
    raw?.imageUrls,
    raw?.images,
    raw?.vehicleImages,
    raw?.photos,
    results,
    rootResults,
    imageDetails,
    imageList,
    firstImage,
  ]);

  const imageUrlCandidate = pickValid(
    result?.imageUrl,
    result?.vehicleImage,
    result?.vehicleImageUrl,
    root?.imageUrl,
    raw?.imageUrl,
    firstImage?.imageUrl,
    firstImage?.ImageUrl,
    extractedImageUrls[0]
  );
  const imageUrl = imageUrlCandidate && imageUrlCandidate.includes('/missing') ? null : imageUrlCandidate;
  const imageUrls = [imageUrl, ...extractedImageUrls]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);

  return {
    vrm: normalizeVrm(pickValid(ident?.vrm, ident?.Vrm, result?.vrm, fallbackVrm)),
    make: pickValid(ident?.dvlaMake, ident?.DvlaMake, modelIdent?.make, modelIdent?.Make, registration?.make, registration?.Make, description?.make, description?.Make, result?.make),
    model: pickValid(ident?.dvlaModel, ident?.DvlaModel, modelIdent?.model, modelIdent?.Model, registration?.model, registration?.Model, description?.model, description?.Model, result?.model),
    color: pickValid(colourDetails?.currentColour, colourDetails?.CurrentColour, colourDetails?.originalColour, description?.colour, description?.Colour, description?.color, description?.Color, result?.color, result?.colour),
    bodyType: pickValid(ident?.dvlaBodyType, ident?.DvlaBodyType, modelDescription?.bodyStyle, modelDescription?.BodyStyle, technical?.bodyType, technical?.BodyType, vehicleDetails?.bodyType, description?.bodyType),
    fuelType: pickValid(ident?.dvlaFuelType, ident?.DvlaFuelType, technical?.fuelType, technical?.FuelType, registration?.fuelType, registration?.FuelType, vehicleDetails?.fuelType),
    yearOfManufacture: pickValid(ident?.yearOfManufacture, ident?.YearOfManufacture, registration?.yearOfManufacture, registration?.YearOfManufacture, vehicleDetails?.yearOfManufacture),
    dateFirstRegistered: pickValid(ident?.dateFirstRegistered, ident?.DateFirstRegistered, registration?.dateFirstRegistered, registration?.DateFirstRegistered, vehicleDetails?.dateFirstRegistered),
    motStatus: pickValid(mot?.status, mot?.Status, status?.motStatus, status?.MotStatus, vehicleDetails?.motStatus),
    motExpiry: pickValid(mot?.expiryDate, mot?.ExpiryDate, mot?.dueDate, mot?.DueDate, status?.motExpiryDate, status?.MotExpiryDate, vehicleDetails?.motExpiry),
    taxStatus: pickValid(tax?.status, tax?.Status, status?.taxStatus, status?.TaxStatus, vehicleDetails?.taxStatus),
    taxDueDate: pickValid(tax?.dueDate, tax?.DueDate, tax?.expiryDate, tax?.ExpiryDate, status?.taxDueDate, status?.TaxDueDate, vehicleDetails?.taxDueDate),
    keeperChanges: Array.isArray(history?.keeperChangeList || history?.KeeperChangeList)
      ? (history?.keeperChangeList || history?.KeeperChangeList).length
      : null,
    engineCapacityCc: pickValid(technical?.engineCapacityCc, technical?.EngineCapacityCc, technical?.cubicCapacity, technical?.CubicCapacity, vehicleDetails?.engineCapacityCc),
    transmission: pickValid(technical?.transmission, technical?.Transmission, description?.transmission, description?.Transmission),
    euroStatus: pickValid(technical?.euroStatus, technical?.EuroStatus, technical?.euroVersion, technical?.EuroVersion),
    co2Emissions: pickValid(technical?.co2Emissions, technical?.Co2Emissions, technical?.co2, technical?.Co2),
    wheelplan: pickValid(technical?.wheelplan, technical?.Wheelplan),
    grossWeightKg: pickValid(technical?.grossWeightKg, technical?.GrossWeightKg, technical?.revenueWeight, technical?.RevenueWeight),
    seats: pickValid(technical?.numberOfSeats, technical?.NumberOfSeats),
    doors: pickValid(technical?.numberOfDoors, technical?.NumberOfDoors),
    imageUrl,
    imageUrls,
    raw,
  };
}

function stripCarcheckFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const {
    vehicleLookup,
    vehicleDetails,
    carcheck,
    carCheck,
    carcheckResult,
    carCheckResult,
    ...safePayload
  } = payload;
  return safePayload;
}

function buildDraftPcnNumber(vrm) {
  const safeVrm = normalizeVrm(vrm || '').slice(0, 6) || 'WARDEN';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  return `PCN-${safeVrm}-${stamp}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [sites, setSites] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [selectedVrm, setSelectedVrm] = useState('');
  const [selectedReason, setSelectedReason] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualObservationMinutes, setManualObservationMinutes] = useState(10);
  const [location, setLocation] = useState(null);
  const [entryFiles, setEntryFiles] = useState([]);
  const [entryPreviews, setEntryPreviews] = useState([]);
  const [entryCapturedAt, setEntryCapturedAt] = useState('');
  const [closingFiles, setClosingFiles] = useState([]);
  const [closingPreviews, setClosingPreviews] = useState([]);
  const [closingCapturedAt, setClosingCapturedAt] = useState('');
  const [authorization, setAuthorization] = useState(null);
  const [vehicleLookup, setVehicleLookup] = useState(null);
  const [vehicleLookupLoading, setVehicleLookupLoading] = useState(false);
  const [vehicleLookupByVrm, setVehicleLookupByVrm] = useState({});
  const [queueItems, setQueueItems] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ticks, setTicks] = useState(0);
  const [selectedContraventionCode, setSelectedContraventionCode] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [activeTab, setActiveTab] = useState('tracked');
  const [selectedTrackedId, setSelectedTrackedId] = useState('');
  const [stepperOpen, setStepperOpen] = useState(false);
  const [breachStatusFilter, setBreachStatusFilter] = useState('all');
  const [convertLoading, setConvertLoading] = useState(false);
  const [convertError, setConvertError] = useState('');
  const [pcnNumberInput, setPcnNumberInput] = useState('');
  const [pcnAmountInput, setPcnAmountInput] = useState('100');
  const [pcnReasonInput, setPcnReasonInput] = useState('No valid permit or payment found');
  const [monitoringSessionActive, setMonitoringSessionActive] = useState(false);
  const [monitoringSessionStartedAt, setMonitoringSessionStartedAt] = useState('');
  const fileInputRef = useRef(null);
  const qrFileInputRef = useRef(null);
  const authReadyRef = useRef(false);
  const capturePhaseRef = useRef('entry');

  const selectedSite = useMemo(() => sites.find((site) => String(site.id) === String(selectedSiteId)) || null, [sites, selectedSiteId]);
  const contraventions = useMemo(() => getContraventionOptions(selectedSite), [selectedSite]);
  const activeTimers = useMemo(() => {
    return queueItems
      .filter((item) => item?.payload?.observationEndTime)
      .map((item) => ({
        id: item.id,
        vrm: item.payload.vrm,
        reason: item.payload.contraventionReason,
        endsAt: item.payload.observationEndTime,
        siteName: item.payload.siteName || selectedSite?.name || 'Site'
      }));
  }, [queueItems, selectedSite?.name]);
  const hasEntryEvidence = entryFiles.length > 0;
  const hasClosingEvidence = closingFiles.length > 0;
  const canRunImageAnalysis = hasEntryEvidence || hasClosingEvidence;
  const canRunLookups = Boolean(selectedSiteId && selectedVrm);
  const canFinalizeBreach = Boolean(selectedSiteId && hasEntryEvidence && hasClosingEvidence && !busy);
  const trackedBreaches = useMemo(() => {
    return queueItems.map((item) => {
      const lifecycle = getBreachLifecycle(item);
      const { entryCount, closingCount } = getEvidencePhaseCounts(item.files);
      const observationEndTime = item?.payload?.observationEndTime;
      const isOpen = Boolean(observationEndTime && new Date(observationEndTime).getTime() > Date.now());
      const minutesRemaining = isOpen
        ? Math.max(0, Math.ceil((new Date(observationEndTime).getTime() - Date.now()) / 60000))
        : 0;
      return {
        id: item.id,
        createdAt: item.createdAt,
        status: item.status,
        lifecycle,
        attempts: item.attempts || 0,
        lastError: item.lastError || '',
        vrm: item.payload?.vrm || 'Pending VRM',
        siteName: item.payload?.siteName || 'Site not set',
        reason: item.payload?.contraventionReason || 'No reason supplied',
        observationStartTime: item.payload?.observationStartTime,
        observationEndTime,
        isOpen,
        minutesRemaining,
        payload: item.payload || {},
        files: Array.isArray(item.files) ? item.files : [],
        entryCount,
        closingCount,
      };
    });
  }, [queueItems, ticks]);

  const syncCandidates = useMemo(
    () => trackedBreaches.filter((item) => item.lifecycle.syncable || item.status === 'syncing'),
    [trackedBreaches]
  );

  const selectedTracked = useMemo(
    () => trackedBreaches.find((entry) => entry.id === selectedTrackedId) || null,
    [trackedBreaches, selectedTrackedId]
  );
  const selectedTrackedVehicleLookup = useMemo(() => {
    const trackedVrm = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm);
    if (!trackedVrm) return null;
    return vehicleLookupByVrm[trackedVrm] || null;
  }, [selectedTracked, vehicleLookupByVrm]);

  const primaryCaptureAction = useMemo(() => {
    if (!hasEntryEvidence) {
      return { key: 'capture-entry', label: 'Capture entry evidence' };
    }
    if (!monitoringSessionActive && !hasClosingEvidence) {
      return { key: 'start-monitoring', label: 'Start monitoring session' };
    }
    if (monitoringSessionActive && !hasClosingEvidence) {
      return { key: 'capture-closing', label: 'Capture closing evidence' };
    }
    return { key: 'finalize', label: selectedTracked ? 'Finalize selected draft' : 'Finalize breach' };
  }, [hasEntryEvidence, hasClosingEvidence, monitoringSessionActive, selectedTracked]);

  const filteredBreaches = useMemo(() => {
    let list = trackedBreaches;
    if (selectedSiteId) {
      list = list.filter((item) => String(item?.payload?.siteId) === String(selectedSiteId));
    }
    if (breachStatusFilter === 'all') return list;
    return list.filter((item) => {
      if (breachStatusFilter === 'open') return item.lifecycle.code === 'DRAFT_OPEN';
      if (breachStatusFilter === 'ready') return item.lifecycle.code === 'READY';
      if (breachStatusFilter === 'submitted') return item.lifecycle.code === 'SUBMITTED';
      if (breachStatusFilter === 'failed') return item.lifecycle.code === 'FAILED';
      if (breachStatusFilter === 'converted') return item.lifecycle.code === 'CONVERTED';
      return true;
    });
  }, [trackedBreaches, breachStatusFilter, selectedSiteId]);

  useEffect(() => {
    if (activeTab !== 'tracked') return;
    const stillSelected = filteredBreaches.some((item) => item.id === selectedTrackedId);
    if (!stillSelected) {
      setSelectedTrackedId(filteredBreaches[0]?.id || '');
    }
  }, [activeTab, filteredBreaches, selectedTrackedId]);

  function getPrimaryActionLabel(item) {
    if (!item) return 'Review';
    if (item.lifecycle.code === 'DRAFT_OPEN') return 'Continue draft';
    if (item.lifecycle.code === 'READY') return 'Submit now';
    if (item.lifecycle.code === 'FAILED') return 'Retry submit';
    if (item.lifecycle.code === 'SUBMITTED') return 'Open conversion';
    if (item.lifecycle.code === 'CONVERTED') return 'View card';
    return 'Review';
  }

  async function handlePrimaryAction(item) {
    if (!item) return;
    if (item.lifecycle.code === 'READY' || item.lifecycle.code === 'FAILED') {
      await handleRetryTracked(item.id);
      return;
    }
    setSelectedTrackedId(item.id);
    if (item.lifecycle.code === 'DRAFT_OPEN') {
      handleReviewTracked(item);
      return;
    }
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromSite = url.searchParams.get('siteId');
    if (fromSite) {
      setSelectedSiteId(fromSite);
      saveStoredSiteId(fromSite);
    } else {
      const saved = loadSession();
      if (saved?.selectedSiteId) setSelectedSiteId(saved.selectedSiteId);
    }
  }, []);

  useEffect(() => {
    async function bootstrapSession() {
      try {
        const session = loadSession();
        const token = session?.token;

        if (!token || !session?.role) {
          await router.replace('/login');
          return;
        }

        setAuthToken(token);
        setProfile(session);
        setOnline(navigator.onLine);
        await Promise.all([loadSites(token), refreshQueue()]);
        authReadyRef.current = true;
      } catch (error) {
        console.error('[warden] profile bootstrap failed', error);
        clearSession();
        await signOutFromWardenApp();
        await router.replace('/login');
      }
    }

    bootstrapSession();
  }, [router]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setTicks((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    entryPreviews.forEach((preview) => URL.revokeObjectURL(preview));
    closingPreviews.forEach((preview) => URL.revokeObjectURL(preview));
  }, [entryPreviews, closingPreviews]);

  useEffect(() => {
    const contravention = contraventions.find((item) => item.code === selectedContraventionCode) || contraventions[0];
    if (contravention) {
      setSelectedReason(contravention.label);
      setManualObservationMinutes(Number(contravention.defaultObservationMinutes || 10));
    }
  }, [contraventions, selectedContraventionCode]);

  useEffect(() => {
    if (selectedSiteId) {
      saveStoredSiteId(selectedSiteId);
    }
  }, [selectedSiteId]);

  useEffect(() => {
    const vrm = normalizeVrm(selectedVrm);
    if (!vrm) {
      setVehicleLookup(null);
      return;
    }
    setVehicleLookup(vehicleLookupByVrm[vrm] || null);
  }, [selectedVrm, vehicleLookupByVrm]);

  async function loadSites(token) {
    const data = await fetchJson('/api/sites?forceAdmin=true', { token });
    const nextSites = Array.isArray(data?.sites) ? data.sites : [];
    const activeSites = nextSites.filter((site) => site.active !== false && site.isActive !== false);
    setSites(activeSites);
    if (!selectedSiteId && activeSites.length > 0) {
      setSelectedSiteId(activeSites[0].id);
      saveStoredSiteId(activeSites[0].id);
    }
  }

  async function refreshQueue() {
    const items = await listQueueItems();
    setQueueItems(items.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  }

  async function handleLogout() {
    clearSession();
    await signOutFromWardenApp();
    await router.replace('/login');
  }

  function openCaptureDialog(phase) {
    capturePhaseRef.current = phase;
    fileInputRef.current?.click();
  }

  async function handleFileSelection(event) {
    const nextFiles = Array.from(event.target.files || []);
    const nextPreviews = toObjectUrlList(nextFiles);
    const capturedAt = new Date().toISOString();
    const phase = capturePhaseRef.current === 'closing' ? 'closing' : 'entry';

    if (phase === 'entry') {
      entryPreviews.forEach((preview) => URL.revokeObjectURL(preview));
      setEntryFiles(nextFiles);
      setEntryPreviews(nextPreviews);
      setEntryCapturedAt(capturedAt);
      setClosingFiles([]);
      closingPreviews.forEach((preview) => URL.revokeObjectURL(preview));
      setClosingPreviews([]);
      setClosingCapturedAt('');
      setMessage(`Opening evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}.`);
    } else {
      closingPreviews.forEach((preview) => URL.revokeObjectURL(preview));
      setClosingFiles(nextFiles);
      setClosingPreviews(nextPreviews);
      setClosingCapturedAt(capturedAt);
      setMessage(`Closing evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}.`);
    }

    event.target.value = '';
  }

  async function uploadEvidenceFiles(evidenceFiles, manualVrm) {
    const token = authToken || getStoredToken();
    if (!token) throw new Error('auth_missing');

    const formData = new FormData();
    evidenceFiles.forEach((file) => formData.append('file', file.blob || file, file.name));
    formData.append('siteId', selectedSiteId);
    formData.append('manualVrm', manualVrm || selectedVrm);

    const response = await fetch(buildApiUrl('/api/warden/uploadevidence'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || 'Failed to analyse evidence');
    }

    return data;
  }

  async function inferVrmFromImage() {
    const sourceFiles = closingFiles.length > 0 ? closingFiles : entryFiles;
    if (!sourceFiles.length) return;
    setBusy(true);
    setMessage('Reading VRM from image…');

    try {
      const data = await uploadEvidenceFiles(sourceFiles, selectedVrm);

      if (data?.vrm) {
        setSelectedVrm(data.vrm);
      }
      if (data?.images?.length) {
        setMessage(`Evidence uploaded. ${data.images.length} image${data.images.length > 1 ? 's' : ''} ready.`);
      }
    } catch (error) {
      console.error('[warden] evidence analysis failed', error);
      setMessage(error?.message || 'Evidence analysis failed');
    } finally {
      setBusy(false);
    }
  }

  async function checkAuthorization(nextVrm) {
    const vrm = normalizeVrm(nextVrm || selectedVrm);
    if (!vrm || !selectedSiteId) return null;
    const token = authToken || getStoredToken();
    if (!token) throw new Error('auth_missing');
    const result = await fetchJson(`/api/parking/check-authorization?vrm=${encodeURIComponent(vrm)}&siteId=${encodeURIComponent(selectedSiteId)}&breachTime=${encodeURIComponent(new Date().toISOString())}`, {
      token
    });
    setAuthorization(result);
    return result;
  }

  async function handlePermitLookup() {
    setBusy(true);
    try {
      const result = await checkAuthorization(selectedVrm);
      if (result?.hasAuthorization) {
        setMessage('E-permit lookup matched an active authorisation for this site.');
      } else {
        setMessage('E-permit lookup completed. No active authorisation matched this site.');
      }
    } catch (error) {
      console.error('[warden] permit lookup failed', error);
      setMessage(error?.message || 'Permit lookup failed');
    } finally {
      setBusy(false);
    }
  }

  function startMonitoringSession() {
    const startedAt = entryCapturedAt || new Date().toISOString();
    if (!selectedSiteId || !selectedVrm || !hasEntryEvidence) {
      setMessage('Capture entry evidence with site and VRM before starting a monitoring session.');
      return;
    }
    if (!entryCapturedAt) {
      setEntryCapturedAt(startedAt);
    }
    setMonitoringSessionStartedAt(startedAt);
    setMonitoringSessionActive(true);
    setMessage(`Monitoring session started for ${selectedVrm}.`);
  }

  function stopMonitoringSession() {
    setMonitoringSessionActive(false);
    if (!closingCapturedAt) {
      setClosingCapturedAt(new Date().toISOString());
    }
    setMessage('Monitoring session ended. Capture closing evidence and finalize when ready.');
  }

  function openPermitQrDialog() {
    qrFileInputRef.current?.click();
  }

  async function handlePermitQrSelection(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (typeof window === 'undefined' || typeof window.BarcodeDetector === 'undefined') {
      setMessage('QR scan is not supported on this device browser. Use permit lookup manually.');
      return;
    }

    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const bitmap = await createImageBitmap(file);
      const codes = await detector.detect(bitmap);
      const raw = String(codes?.[0]?.rawValue || '').trim();
      if (!raw) {
        setMessage('No QR code detected. Try a clearer permit QR image.');
        return;
      }

      const parsedVrmMatch = raw.match(/(?:vrm|plate|registration)[:=\s]+([A-Za-z0-9]{2,10})/i);
      const parsedVrm = parsedVrmMatch ? normalizeVrm(parsedVrmMatch[1]) : '';
      if (parsedVrm) {
        setSelectedVrm(parsedVrm);
      }
      setManualNote((prev) => [prev, `Permit QR: ${raw}`].filter(Boolean).join('\n'));

      if ((parsedVrm || selectedVrm) && selectedSiteId) {
        await checkAuthorization(parsedVrm || selectedVrm);
        setMessage(`Permit QR scanned${parsedVrm ? ` for ${parsedVrm}` : ''}. Authorization refreshed.`);
      } else {
        setMessage('Permit QR scanned. Select site/VRM to run authorization check.');
      }
    } catch (error) {
      console.error('[warden] permit QR scan failed', error);
      setMessage(error?.message || 'Permit QR scan failed');
    }
  }

  async function runVehicleLookupForVrm(inputVrm) {
    const vrm = normalizeVrm(inputVrm);
    if (!vrm) {
      setMessage('Enter or read a VRM before running car check.');
      return;
    }

    const cachedLookup = vehicleLookupByVrm[vrm];
    if (cachedLookup) {
      setVehicleLookup(cachedLookup);
      setMessage(`Carcheck loaded from app memory${cachedLookup?.make || cachedLookup?.model ? `: ${[cachedLookup.make, cachedLookup.model].filter(Boolean).join(' ')}` : ''}.`);
      return;
    }

    setVehicleLookupLoading(true);
    try {
      const token = authToken || getStoredToken();
      if (!token) throw new Error('auth_missing');
      const result = await fetchJson(`/api/carcheck?vrm=${encodeURIComponent(vrm)}`, { token });
      const normalized = normalizeVehicleLookup(result, vrm);
      setVehicleLookup(normalized);
      setVehicleLookupByVrm((current) => ({ ...current, [vrm]: normalized }));
      setMessage(`Carcheck complete${normalized?.make || normalized?.model ? `: ${[normalized.make, normalized.model].filter(Boolean).join(' ')}` : ''}.`);
    } catch (error) {
      console.error('[warden] vehicle lookup failed', error);
      setVehicleLookup(null);
      setMessage(error?.message || 'Carcheck failed');
    } finally {
      setVehicleLookupLoading(false);
    }
  }

  async function handleVehicleLookup() {
    await runVehicleLookupForVrm(selectedVrm);
  }

  async function queueOrSendCapture({ immediate = false, targetItemId = '' } = {}) {
    if (!selectedSiteId) {
      setMessage('Choose a patrol site before submitting.');
      return;
    }
    if (!selectedVrm) {
      setMessage('Enter or capture a VRM first.');
      return;
    }

    if (entryFiles.length === 0) {
      setMessage('Capture opening evidence before creating a breach.');
      return;
    }

    if (closingFiles.length === 0) {
      setMessage('Capture closing evidence before creating a breach.');
      return;
    }

    const observationRequired = manualObservationMinutes > 0;
    const now = new Date();
    const locationSnapshot = location || (await getCurrentLocation());
    const entryTime = entryCapturedAt || now.toISOString();
    const closingTime = closingCapturedAt || now.toISOString();
    const elapsedMinutes = diffMinutes(entryTime, closingTime);

    if (!elapsedMinutes && observationRequired) {
      setMessage('Closing evidence must be captured after opening evidence.');
      return;
    }

    if (observationRequired && elapsedMinutes < manualObservationMinutes) {
      setMessage(`Closing evidence must be at least ${manualObservationMinutes} minutes after opening evidence.`);
      return;
    }

    const payload = stripCarcheckFromPayload({
      vrm: normalizeVrm(selectedVrm),
      siteId: selectedSiteId,
      siteName: selectedSite?.name || selectedSite?.displayName || selectedSiteId,
      source: 'WARDEN',
      wardenId: profile?.uid,
      actorId: profile?.uid,
      contraventionReason: selectedReason,
      status: 'QUEUED_FOR_QC',
      location: locationSnapshot || null,
      observationStartTime: observationRequired ? entryTime : null,
      observationEndTime: observationRequired ? closingTime : null,
      entryCapturedAt: entryTime,
      closingCapturedAt: closingTime,
      realExitObserved: true,
      breachEvidenceMode: 'paired_exit',
      actualMinutes: elapsedMinutes,
      manualNote,
      authorization,
      selectedContraventionCode,
    });

    const files = [
      ...entryFiles.map((file) => ({
        name: file.name,
        type: file.type,
        blob: file,
        phase: 'entry',
      })),
      ...closingFiles.map((file) => ({
        name: file.name,
        type: file.type,
        blob: file,
        phase: 'closing',
      })),
    ];

    let itemId = targetItemId;
    if (targetItemId) {
      const existing = (await listQueueItems()).find((item) => item.id === targetItemId);
      if (existing) {
        await saveQueueItem({
          ...existing,
          payload: {
            ...existing.payload,
            ...payload,
            breachLifecycle: 'READY_FOR_SYNC',
          },
          files,
          status: 'queued',
          updatedAt: new Date().toISOString(),
          lastError: null,
        });
      } else {
        itemId = '';
      }
    }

    if (!itemId) {
      const item = createQueueItem({ payload, files });
      item.payload = { ...item.payload, breachLifecycle: 'READY_FOR_SYNC' };
      itemId = item.id;
      await saveQueueItem(item);
    }

    await refreshQueue();

    if (!online && !immediate) {
      setMessage('Captured offline. The breach is ready and queued for sync.');
      return;
    }

    await syncQueueItem(itemId);
  }

  async function handleSaveDraft() {
    if (!selectedSiteId) {
      setMessage('Choose a patrol site before saving a draft.');
      return;
    }
    if (!selectedVrm) {
      setMessage('Enter or capture a VRM before saving a draft.');
      return;
    }
    if (entryFiles.length === 0) {
      setMessage('Capture opening evidence before saving a draft.');
      return;
    }

    const nowIso = new Date().toISOString();
    const entryTime = entryCapturedAt || nowIso;
    const draftPayload = stripCarcheckFromPayload({
      vrm: normalizeVrm(selectedVrm),
      siteId: selectedSiteId,
      siteName: selectedSite?.name || selectedSite?.displayName || selectedSiteId,
      source: 'WARDEN',
      wardenId: profile?.uid,
      actorId: profile?.uid,
      contraventionReason: selectedReason,
      status: 'DRAFT_OPEN',
      breachLifecycle: 'DRAFT_OPEN',
      location: location || null,
      observationStartTime: entryTime,
      observationEndTime: null,
      entryCapturedAt: entryTime,
      closingCapturedAt: null,
      manualNote,
      authorization,
      selectedContraventionCode,
    });

    const draftFiles = [
      ...entryFiles.map((file) => ({
        name: file.name,
        type: file.type,
        blob: file,
        phase: 'entry',
      })),
    ];

    let draftId = selectedTrackedId;
    if (draftId) {
      const existing = (await listQueueItems()).find((item) => item.id === draftId);
      if (existing) {
        await saveQueueItem({
          ...existing,
          payload: { ...existing.payload, ...draftPayload },
          files: draftFiles,
          status: 'draft',
          updatedAt: nowIso,
          lastError: null,
        });
      } else {
        draftId = '';
      }
    }

    if (!draftId) {
      const item = createQueueItem({ payload: draftPayload, files: draftFiles });
      item.status = 'draft';
      draftId = item.id;
      await saveQueueItem(item);
    }

    await refreshQueue();
    setSelectedTrackedId(draftId);
    setClosingFiles([]);
    setClosingPreviews([]);
    setClosingCapturedAt('');
    setMonitoringSessionStartedAt(entryTime);
    setMonitoringSessionActive(true);
    setMessage('Open draft saved. Capture closing evidence later to finalise.');
  }

  async function handleStepperComplete({
    vrm,
    siteId,
    siteName,
    contraventionCode,
    contraventionLabel,
    observationMinutes,
    files,
    note
  }) {
    try {
      setBusy(true);
      setMessage(`Saving new tracking session for VRM ${vrm}…`);

      const entryTime = new Date().toISOString();
      const endTime = observationMinutes > 0
        ? new Date(Date.now() + observationMinutes * 60000).toISOString()
        : '';

      const draftPayload = {
        vrm,
        contraventionCode,
        contraventionReason: contraventionLabel,
        observationStartTime: entryTime,
        observationEndTime: endTime,
        siteId,
        siteName,
        note,
      };

      const draftFiles = files.map((file, i) => ({
        name: `entry_${i}_${Date.now()}.jpg`,
        type: file.type,
        blob: file,
        phase: 'entry',
      }));

      const item = createQueueItem({ payload: draftPayload, files: draftFiles });
      item.status = 'draft';

      await saveQueueItem(item);
      await refreshQueue();

      setStepperOpen(false);
      setSelectedTrackedId(item.id);
      setActiveTab('tracked');

      // Pre-load the new item into active workflow state using handleReviewTracked
      handleReviewTracked(item);
      setMessage(`Started tracking session for vehicle ${vrm}.`);
    } catch (e) {
      console.error('[warden] failed to create stepper draft', e);
      setMessage(e.message || 'Error occurred starting stepper session.');
    } finally {
      setBusy(false);
    }
  }

  async function syncQueueItem(itemId) {
    const queuedItem = (await listQueueItems()).find((item) => item.id === itemId);
    if (!queuedItem) return;

    const lifecycle = getBreachLifecycle(queuedItem);
    if (!lifecycle.syncable && queuedItem.status !== 'syncing') {
      setMessage('This breach is still a draft and needs both opening and closing evidence before submission.');
      return;
    }

    try {
      await updateQueueItem(itemId, { status: 'syncing', attempts: queuedItem.attempts + 1, updatedAt: new Date().toISOString(), lastError: null });
      await refreshQueue();

      const token = authToken || getStoredToken();
      if (!token) throw new Error('auth_missing');

      const storedFiles = Array.isArray(queuedItem.files) ? queuedItem.files : [];
      let entryEvidenceFiles = storedFiles.filter((file) => file.phase === 'entry');
      let closingEvidenceFiles = storedFiles.filter((file) => file.phase === 'closing');

      if (entryEvidenceFiles.length === 0 && closingEvidenceFiles.length === 0 && storedFiles.length >= 2) {
        entryEvidenceFiles = [storedFiles[0]];
        closingEvidenceFiles = storedFiles.slice(1);
      }

      if (entryEvidenceFiles.length === 0 || closingEvidenceFiles.length === 0) {
        throw new Error('Paired opening and closing evidence is required before sync');
      }

      const entryEvidence = await uploadEvidenceFiles(entryEvidenceFiles, queuedItem.payload.vrm);
      const closingEvidence = await uploadEvidenceFiles(closingEvidenceFiles, queuedItem.payload.vrm);

      const vrm = normalizeVrm(closingEvidence.vrm || entryEvidence.vrm || queuedItem.payload.vrm);
      const authData = await checkAuthorization(vrm);
      const entryTime = queuedItem.payload.entryCapturedAt || queuedItem.payload.observationStartTime || new Date().toISOString();
      const closingTime = queuedItem.payload.closingCapturedAt || queuedItem.payload.observationEndTime || new Date().toISOString();
      const entryFrame = buildEvidenceFrame(entryEvidence.images?.[0], entryTime);
      const closingFrame = buildEvidenceFrame(closingEvidence.images?.[0], closingTime);
      const allImages = [...(entryEvidence.images || []), ...(closingEvidence.images || [])];
      const safeQueuedPayload = stripCarcheckFromPayload(queuedItem.payload);
      const breachPayload = {
        ...safeQueuedPayload,
        vrm,
        images: allImages,
        imageUrls: allImages,
        evidence: {
          entry: entryFrame,
          latest: closingFrame,
          exit: {
            ...closingFrame,
            realExitObserved: true,
            closedAt: closingTime,
            breachEvidenceMode: 'paired_exit',
          },
        },
        closingEvidence: {
          ...closingFrame,
          realExitObserved: true,
          closedAt: closingTime,
          breachEvidenceMode: 'paired_exit',
        },
        authorization: authData,
        status: 'QUEUED_FOR_QC',
        breachLifecycle: 'SUBMITTED',
        source: 'WARDEN',
        wardenId: profile?.uid,
        actorId: profile?.uid,
        realExitObserved: true,
        breachEvidenceMode: 'paired_exit',
        entryTime,
        closedAt: closingTime,
        lastSeen: closingTime,
        actualMinutes: diffMinutes(entryTime, closingTime),
      };

      const breachResult = await fetchJson('/api/breaches/wardencapture', {
        method: 'POST',
        token,
        body: breachPayload
      });

      const breachId = breachResult?.id || breachResult?.breachId || queuedItem?.payload?.breachId || '';
      await updateQueueItem(itemId, {
        status: 'submitted',
        lastError: null,
        updatedAt: new Date().toISOString(),
        payload: {
          ...safeQueuedPayload,
          ...breachPayload,
          breachId,
          breachLifecycle: 'SUBMITTED',
          convertedToPcn: false,
        },
      });

      setMessage(`Breach submitted successfully: ${breachId || vrm}`);
      setSelectedVrm('');
      setEntryFiles([]);
      setEntryPreviews([]);
      setEntryCapturedAt('');
      setClosingFiles([]);
      setClosingPreviews([]);
      setClosingCapturedAt('');
      setAuthorization(null);
      setVehicleLookup(null);
      setManualNote('');
      setMonitoringSessionActive(false);
      setMonitoringSessionStartedAt('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      console.error('[warden] sync failed', error);
      await updateQueueItem(itemId, {
        status: 'failed',
        lastError: error?.message || 'Sync failed',
        updatedAt: new Date().toISOString()
      });
      setMessage(error?.message || 'Sync failed');
    } finally {
      await refreshQueue();
    }
  }

  async function handleConvertToPcn() {
    if (!selectedTracked) return;
    const breachId = selectedTracked?.payload?.breachId || '';
    if (!breachId) {
      setConvertError('This breach has not been submitted yet, so it cannot be converted to PCN.');
      return;
    }

    if (!pcnNumberInput.trim()) {
      setConvertError('PCN number is required.');
      return;
    }

    const amount = Number(pcnAmountInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setConvertError('A valid PCN amount is required.');
      return;
    }

    setConvertLoading(true);
    setConvertError('');
    try {
      const token = authToken || getStoredToken();
      if (!token) throw new Error('auth_missing');

      const images = [
        ...(Array.isArray(selectedTracked?.payload?.images) ? selectedTracked.payload.images : []),
        ...(Array.isArray(selectedTracked?.payload?.imageUrls) ? selectedTracked.payload.imageUrls : []),
      ]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .filter((value, index, all) => all.indexOf(value) === index);
      const response = await fetchJson('/api/breaches/convert-to-pcn', {
        method: 'POST',
        token,
        body: {
          breachId,
          pcnNumber: pcnNumberInput.trim(),
          amount,
          reason: pcnReasonInput.trim() || 'No valid permit or payment found',
          notes: `Converted from breach ${breachId}`,
          vrm: selectedTracked.vrm,
          timestamp: selectedTracked.observationEndTime || selectedTracked.createdAt || new Date().toISOString(),
          siteId: selectedTracked?.payload?.siteId || '',
          siteName: selectedTracked.siteName || '',
          evidence: selectedTracked?.payload?.evidence || {},
          images,
        },
      });

      await updateQueueItem(selectedTracked.id, {
        status: 'submitted',
        updatedAt: new Date().toISOString(),
        payload: {
          ...selectedTracked.payload,
          breachLifecycle: 'CONVERTED_TO_PCN',
          convertedToPcn: true,
          convertedAt: new Date().toISOString(),
          pcnAmount: amount,
          pcnReason: pcnReasonInput.trim() || 'No valid permit or payment found',
          pcnId: response?.id || response?.pcnId || '',
          pcnNumber: response?.pcnNumber || pcnNumberInput.trim(),
        },
      });
      await refreshQueue();
      setMessage(`Breach converted to PCN ${response?.pcnNumber || pcnNumberInput.trim()} and routed for QA escalation.`);
    } catch (error) {
      console.error('[warden] convert breach failed', error);
      setConvertError(error?.message || 'Failed to convert breach to PCN');
    } finally {
      setConvertLoading(false);
    }
  }

  async function syncQueue() {
    if (syncing) return;
    setSyncing(true);
    try {
      const items = await listQueueItems();
      for (const item of items.filter((entry) => getBreachLifecycle(entry).syncable || entry.status === 'syncing')) {
        await syncQueueItem(item.id);
      }
    } finally {
      setSyncing(false);
    }
  }

  async function handleCancelTracked(id) {
    try {
      await deleteQueueItem(id);
      await refreshQueue();
      if (selectedTrackedId === id) {
        setSelectedTrackedId('');
      }
      setMessage('Tracked breach cancelled and removed from queue.');
    } catch (error) {
      console.error('[warden] cancel tracked breach failed', error);
      setMessage(error?.message || 'Failed to cancel tracked breach');
    }
  }

  async function handleRetryTracked(id) {
    setSyncing(true);
    try {
      await syncQueueItem(id);
    } finally {
      setSyncing(false);
    }
  }

  function handleReviewTracked(item) {
    setSelectedTrackedId(item.id);
    if (item?.payload?.siteId) {
      setSelectedSiteId(item.payload.siteId);
    }
    if (item?.payload?.vrm) {
      setSelectedVrm(item.payload.vrm);
    }
    if (item?.payload?.manualNote) {
      setManualNote(item.payload.manualNote);
    }
    if (item?.payload?.selectedContraventionCode) {
      setSelectedContraventionCode(item.payload.selectedContraventionCode);
    }
    if (item?.payload?.authorization) {
      setAuthorization(item.payload.authorization);
    }

    const trackedVrm = normalizeVrm(item?.payload?.vrm || item?.vrm);
    setVehicleLookup(trackedVrm ? (vehicleLookupByVrm[trackedVrm] || null) : null);

    const entryEvidence = (Array.isArray(item.files) ? item.files : [])
      .filter((file) => file?.phase === 'entry' && file?.blob)
      .map((file) => file.blob);
    const closingEvidence = (Array.isArray(item.files) ? item.files : [])
      .filter((file) => file?.phase === 'closing' && file?.blob)
      .map((file) => file.blob);

    entryPreviews.forEach((preview) => URL.revokeObjectURL(preview));
    closingPreviews.forEach((preview) => URL.revokeObjectURL(preview));

    setEntryFiles(entryEvidence);
    setClosingFiles(closingEvidence);
    setEntryPreviews(toObjectUrlList(entryEvidence));
    setClosingPreviews(toObjectUrlList(closingEvidence));
    setEntryCapturedAt(item?.payload?.entryCapturedAt || item?.payload?.observationStartTime || '');
    setClosingCapturedAt(item?.payload?.closingCapturedAt || item?.payload?.observationEndTime || '');

    const sessionStart = item?.payload?.entryCapturedAt || item?.payload?.observationStartTime || '';
    setMonitoringSessionStartedAt(sessionStart);
    setMonitoringSessionActive(Boolean(sessionStart) && closingEvidence.length === 0);

    setPcnNumberInput(item?.payload?.pcnNumber || buildDraftPcnNumber(item?.payload?.vrm || item.vrm));
    setPcnAmountInput(item?.payload?.pcnAmount ? String(item.payload.pcnAmount) : '100');
    setPcnReasonInput(item?.payload?.pcnReason || 'No valid permit or payment found');
    setConvertError('');

    setMessage(`Loaded ${item.lifecycle.label.toLowerCase()} ${item.vrm} for review.`);
  }

  async function handleFinalize() {
    setBusy(true);
    try {
      setLocation((await getCurrentLocation()) || location);
      await checkAuthorization(selectedVrm);
      await queueOrSendCapture({ targetItemId: selectedTrackedId || '' });
    } finally {
      setBusy(false);
    }
  }

  async function handlePrimaryCaptureAction() {
    if (primaryCaptureAction.key === 'capture-entry') {
      openCaptureDialog('entry');
      return;
    }
    if (primaryCaptureAction.key === 'start-monitoring') {
      startMonitoringSession();
      return;
    }
    if (primaryCaptureAction.key === 'capture-closing') {
      openCaptureDialog('closing');
      return;
    }
    await handleFinalize();
  }

  function selectContravention(code) {
    const next = contraventions.find((item) => item.code === code) || contraventions[0];
    setSelectedContraventionCode(code);
    if (next) {
      setSelectedReason(next.label);
      setManualObservationMinutes(Number(next.defaultObservationMinutes || 10));
    }
  }

  if (!profile) {
    return (
      <div className="screen-loading">
        <LoadingSpinner />
        <span>Loading secure patrol workspace…</span>
      </div>
    );
  }

  return (
    <AppShell
      profile={profile}
      siteName={selectedSite?.name || selectedSite?.displayName || ''}
      online={online}
      syncing={syncing}
      queueCount={syncCandidates.length}
      onLogout={handleLogout}
      onSync={syncQueue}
    >
      <section className="tab-shell stack gap-large">
        <div className="tab-bar" role="tablist" aria-label="Warden workspace sections">
          <button type="button" role="tab" aria-selected={activeTab === 'tracked'} className={`tab-button ${activeTab === 'tracked' ? 'tab-button-active' : ''}`} onClick={() => setActiveTab('tracked')}>
            Patrol
          </button>
          <button type="button" role="tab" aria-selected={activeTab === 'queue'} className={`tab-button ${activeTab === 'queue' ? 'tab-button-active' : ''}`} onClick={() => setActiveTab('queue')}>
            Queue
          </button>
        </div>

        {message ? <div className="notice notice-info">{message}</div> : null}

        {activeTab === 'tracked' ? (
          <section className="workspace-grid tracked-layout">
            {/* ── Left: Breach list ── */}
            <div className="card stack gap-large">
              <div className="card-header-row">
                <div>
                  <p className="eyebrow">Patrol inbox</p>
                  <h3>Active enforcement queue</h3>
                </div>
                <span className="muted-chip">{trackedBreaches.length} tracked</span>
              </div>

              {trackedBreaches.filter(i => i.lifecycle.code === 'DRAFT_OPEN').length > 0 ? (
                <div className="active-sessions-bar">
                  <span className="active-sessions-count">
                    {trackedBreaches.filter(i => i.lifecycle.code === 'DRAFT_OPEN').length}
                  </span>
                  <span>Active observation sessions currently ticking</span>
                </div>
              ) : null}

              <div style={{ display: 'grid', gap: 6, margin: '8px 0 16px 0' }}>
                <span className="meta-label">Current Patrol Zone / Bay Filter</span>
                <select className="field-select" value={selectedSiteId} onChange={(event) => setSelectedSiteId(event.target.value)}>
                  <option value="">All active sites / bays</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.displayName || site.name || site.location || site.id}
                    </option>
                  ))}
                </select>
              </div>

              <div className="inline-actions status-filter-bar">
                {[
                  { key: 'all', label: 'All', count: trackedBreaches.length },
                  { key: 'open', label: 'Open', count: trackedBreaches.filter(i => i.lifecycle.code === 'DRAFT_OPEN').length },
                  { key: 'ready', label: 'Ready', count: trackedBreaches.filter(i => i.lifecycle.code === 'READY').length },
                  { key: 'submitted', label: 'Submitted', count: trackedBreaches.filter(i => i.lifecycle.code === 'SUBMITTED').length },
                  { key: 'converted', label: 'Converted', count: trackedBreaches.filter(i => i.lifecycle.code === 'CONVERTED').length },
                  { key: 'failed', label: 'Failed', count: trackedBreaches.filter(i => i.lifecycle.code === 'FAILED').length },
                ].map(({ key, label, count }) => (
                  <button
                    key={key}
                    type="button"
                    className={`ghost-button ${breachStatusFilter === key ? 'tab-button-active' : ''}`}
                    onClick={() => setBreachStatusFilter(key)}
                  >
                    {label} {count > 0 ? <span style={{ opacity: 0.7, marginLeft: 3 }}>{count}</span> : null}
                  </button>
                ))}
              </div>

              {filteredBreaches.length === 0 ? (
                <p className="card-copy">No tracked breaches yet. Finalised captures and offline submissions will appear here.</p>
              ) : (
                <div className="queue-list">
                  {filteredBreaches.map((item) => (
                    <article
                      key={item.id}
                      className={`breach-card ${selectedTrackedId === item.id ? 'breach-card-selected' : ''}`}
                      onClick={() => handleReviewTracked(item)}
                    >
                      <div className="breach-card-top">
                        <div>
                          <div className="breach-card-vrm">{item.vrm}</div>
                          <div className="breach-card-site">{item.siteName}</div>
                        </div>
                        <span className={`lc-pill lc-${item.lifecycle.code}`}>
                          <span className="lc-pill-dot" />
                          {item.lifecycle.label}
                        </span>
                      </div>

                      <div className="breach-card-reason">{item.reason}</div>

                      <div className="breach-card-kpi">
                        <div className="breach-card-kpi-item">
                          <span className="breach-card-kpi-label">Entry imgs</span>
                          <span className="breach-card-kpi-val">{item.entryCount || '—'}</span>
                        </div>
                        <div className="breach-card-kpi-item">
                          <span className="breach-card-kpi-label">Exit imgs</span>
                          <span className="breach-card-kpi-val">{item.closingCount || '—'}</span>
                        </div>
                        <div className="breach-card-kpi-item">
                          <span className="breach-card-kpi-label">Created</span>
                          <span className="breach-card-kpi-val">{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {item.attempts > 0 ? (
                          <div className="breach-card-kpi-item">
                            <span className="breach-card-kpi-label">Attempts</span>
                            <span className="breach-card-kpi-val">{item.attempts}</span>
                          </div>
                        ) : null}
                      </div>

                      {item.isOpen ? (
                        <div className="breach-card-timer">
                          ⏱ Observation open — {item.minutesRemaining} min remaining
                        </div>
                      ) : null}

                      {item.lastError ? (
                        <span className="tracked-error">Error: {item.lastError}</span>
                      ) : null}

                      <div className="breach-card-actions">
                        <button
                          type="button"
                          className="primary-button"
                          style={{ padding: '8px 14px', fontSize: '13px' }}
                          onClick={(e) => { e.stopPropagation(); handlePrimaryAction(item); }}
                          disabled={syncing && (item.lifecycle.code === 'READY' || item.lifecycle.code === 'FAILED')}
                        >
                          {getPrimaryActionLabel(item)}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          style={{ padding: '8px 14px', fontSize: '13px' }}
                          onClick={(e) => { e.stopPropagation(); handleReviewTracked(item); }}
                        >
                          Review
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          style={{ padding: '8px 14px', fontSize: '13px' }}
                          onClick={(e) => { e.stopPropagation(); handleRetryTracked(item.id); }}
                          disabled={syncing || !item.lifecycle.syncable}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          className="ghost-button ghost-danger"
                          style={{ padding: '8px 14px', fontSize: '13px' }}
                          onClick={(e) => { e.stopPropagation(); handleCancelTracked(item.id); }}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            {/* ── Right: Detail pane ── */}
            {selectedTracked ? (
              <div className="card stack gap-large">
                <div className="card-header-row">
                  <div>
                    <p className="eyebrow">Breach detail</p>
                    <h3 style={{ fontFamily: 'monospace', letterSpacing: '0.06em' }}>{selectedTracked.vrm}</h3>
                  </div>
                  <span className={`lc-pill lc-${selectedTracked.lifecycle.code}`}>
                    <span className="lc-pill-dot" />
                    {selectedTracked.lifecycle.label}
                  </span>
                </div>

                {/* KPI strip */}
                <div className="breach-kpi-row">
                  <div className="kpi-cell">
                    <span className="kpi-cell-label">Site</span>
                    <span className="kpi-cell-val">{selectedTracked.siteName}</span>
                  </div>
                  <div className="kpi-cell">
                    <span className="kpi-cell-label">Created</span>
                    <span className="kpi-cell-val">{new Date(selectedTracked.createdAt).toLocaleDateString([], { day: '2-digit', month: 'short' })}</span>
                  </div>
                  <div className="kpi-cell">
                    <span className="kpi-cell-label">Evidence</span>
                    <span className="kpi-cell-val">{selectedTracked.entryCount}↑ / {selectedTracked.closingCount}↓</span>
                  </div>
                  <div className="kpi-cell">
                    <span className="kpi-cell-label">Attempts</span>
                    <span className="kpi-cell-val">{selectedTracked.attempts || 0}</span>
                  </div>
                </div>

                {/* Observation timer banner */}
                {selectedTracked.isOpen ? (
                  <div className="session-active-banner">
                    <span className="session-active-dot" />
                    Observation open — {selectedTracked.minutesRemaining} min remaining
                  </div>
                ) : null}

                {/* Timestamps row */}
                <div className="detail-grid">
                  <div><span className="meta-label">Contravention</span><strong>{selectedTracked.reason}</strong></div>
                  <div><span className="meta-label">Breach ID</span><strong className="text-mono">{selectedTracked?.payload?.breachId || 'Pending submission'}</strong></div>
                  <div><span className="meta-label">Obs. start</span><strong>{selectedTracked.observationStartTime ? new Date(selectedTracked.observationStartTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'}</strong></div>
                  <div><span className="meta-label">Obs. end</span><strong>{selectedTracked.observationEndTime ? new Date(selectedTracked.observationEndTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'}</strong></div>
                </div>

                {/* Evidence with inline capture */}
                <div className="border-top-subtle">
                  <p className="detail-section-label">Evidence pair</p>
                  <div className="evidence-split-grid">
                    <div className="evidence-frame">
                      <div className="evidence-frame-header">
                        <span className="evidence-frame-label-entry">▶ Entry</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {selectedTracked.entryCount > 0 ? <span className="evidence-count-badge evidence-count-badge-entry">{selectedTracked.entryCount}</span> : null}
                          <button
                            type="button"
                            className="ghost-button"
                            style={{ padding: '2px 8px', fontSize: '10px', borderRadius: '6px' }}
                            onClick={() => { handleReviewTracked(selectedTracked); setTimeout(() => openCaptureDialog('entry'), 80); }}
                          >
                            {selectedTracked.entryCount > 0 ? 'Re-cap' : 'Capture ↑'}
                          </button>
                        </div>
                      </div>
                      {entryPreviews.length > 0 ? (
                        <img src={entryPreviews[0]} alt="Entry evidence" className="evidence-frame-img" />
                      ) : (
                        <div className="evidence-frame-placeholder">No preview.<br />Tap Capture ↑.</div>
                      )}
                      {selectedTracked.observationStartTime ? (
                        <div className="evidence-frame-ts">⏱ {new Date(selectedTracked.observationStartTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
                      ) : null}
                    </div>
                    <div className="evidence-frame">
                      <div className="evidence-frame-header">
                        <span className="evidence-frame-label-exit">■ Exit</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {selectedTracked.closingCount > 0 ? <span className="evidence-count-badge evidence-count-badge-exit">{selectedTracked.closingCount}</span> : null}
                          <button
                            type="button"
                            className="ghost-button"
                            style={{ padding: '2px 8px', fontSize: '10px', borderRadius: '6px' }}
                            onClick={() => { handleReviewTracked(selectedTracked); setTimeout(() => openCaptureDialog('closing'), 80); }}
                            disabled={selectedTracked.entryCount === 0}
                          >
                            {selectedTracked.closingCount > 0 ? 'Re-cap' : 'Capture ↓'}
                          </button>
                        </div>
                      </div>
                      {closingPreviews.length > 0 ? (
                        <img src={closingPreviews[0]} alt="Exit evidence" className="evidence-frame-img" />
                      ) : (
                        <div className="evidence-frame-placeholder">No preview.<br />{selectedTracked.entryCount > 0 ? 'Tap Capture ↓.' : 'Entry first.'}</div>
                      )}
                      {selectedTracked.observationEndTime ? (
                        <div className="evidence-frame-ts">⏱ {new Date(selectedTracked.observationEndTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
                      ) : null}
                    </div>
                  </div>

                  {/* Finalize / session controls */}
                  <div className="inline-actions" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="primary-button"
                      style={{ padding: '9px 16px', fontSize: '13px' }}
                      onClick={() => { handleReviewTracked(selectedTracked); setTimeout(handleFinalize, 80); }}
                      disabled={busy || selectedTracked.entryCount === 0 || selectedTracked.closingCount === 0}
                    >
                      {busy ? 'Finalizing…' : 'Finalize breach'}
                    </button>
                    {selectedTracked.lifecycle.syncable || selectedTracked.status === 'syncing' ? (
                      <button
                        type="button"
                        className="secondary-button"
                        style={{ padding: '9px 16px', fontSize: '13px' }}
                        onClick={() => handleRetryTracked(selectedTracked.id)}
                        disabled={syncing}
                      >
                        {syncing ? 'Syncing…' : 'Submit now'}
                      </button>
                    ) : null}
                    {selectedTracked.lifecycle.code === 'DRAFT_OPEN' ? (
                      <button
                        type="button"
                        className="ghost-button"
                        style={{ padding: '9px 16px', fontSize: '13px' }}
                        onClick={() => { handleReviewTracked(selectedTracked); setTimeout(startMonitoringSession, 80); }}
                        disabled={selectedTracked.entryCount === 0 || monitoringSessionActive}
                      >
                        Start session
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* VRM + Contravention editing */}
                <div className="border-top-subtle">
                  <p className="detail-section-label">Contravention details</p>
                  <div className="capture-grid">
                    <label>
                      VRM
                      <input
                        value={selectedVrm || selectedTracked.vrm || ''}
                        onChange={(e) => setSelectedVrm(normalizeVrm(e.target.value))}
                        placeholder="AB12CDE"
                        style={{ fontFamily: 'monospace', fontWeight: 800 }}
                      />
                    </label>
                    <label>
                      Contravention
                      <select value={selectedContraventionCode} onChange={(e) => selectContravention(e.target.value)}>
                        {contraventions.map((item) => (
                          <option key={item.code} value={item.code}>{item.code} – {item.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label style={{ marginTop: 8, display: 'grid', gap: 6, fontWeight: 600, fontSize: 14 }}>
                    Warden notes
                    <textarea rows={2} value={manualNote} onChange={(e) => setManualNote(e.target.value)} placeholder="Bay position, signage, observations…" />
                  </label>
                </div>

                {/* Permit + car check actions */}
                <div className="border-top-subtle">
                  <p className="detail-section-label">Live validation</p>

                  {authorization ? (
                    <div className={`notice ${authorization.hasAuthorization ? 'notice-info' : 'notice-error'}`} style={{ marginBottom: 10 }}>
                      <strong>{authorization.hasAuthorization ? '✓ Authorised' : '✗ No valid permit'}</strong>
                      {authorization.authorization?.type ? ` — ${authorization.authorization.type}` : ''}
                      {authorization.authorization?.status ? ` (${authorization.authorization.status})` : ''}
                    </div>
                  ) : null}

                  <div className="action-strip">
                    <span className="action-strip-label">Checks</span>
                    <button
                      type="button"
                      className="quick-action-button"
                      onClick={async () => {
                        const vrm = selectedTracked?.payload?.vrm || selectedTracked?.vrm;
                        handleReviewTracked(selectedTracked);
                        await checkAuthorization(vrm);
                      }}
                      disabled={busy || !selectedTracked.vrm}
                    >
                      ✓ Verify e-permit
                    </button>
                    <button type="button" className="quick-action-button" onClick={openPermitQrDialog}>
                      ⬛ Scan QR permit
                    </button>
                    <button
                      type="button"
                      className="quick-action-button"
                      onClick={async () => {
                        const vrm = selectedTracked?.payload?.vrm || selectedTracked?.vrm;
                        if (!vrm) return;
                        setSelectedVrm(vrm);
                        await runVehicleLookupForVrm(vrm);
                      }}
                      disabled={vehicleLookupLoading || !selectedTracked?.vrm}
                    >
                      {vehicleLookupLoading ? '⏳ Checking…' : '🚗 Car check'}
                    </button>
                    <button
                      type="button"
                      className="quick-action-button"
                      onClick={() => inferVrmFromImage()}
                      disabled={busy || (!entryPreviews.length && !closingPreviews.length)}
                    >
                      🔍 Analyse VRM
                    </button>
                  </div>

                  {selectedTrackedVehicleLookup ? (
                    <div className="detail-grid" style={{ marginTop: 10 }}>
                      <div><span className="meta-label">Make</span><strong>{selectedTrackedVehicleLookup.make || '—'}</strong></div>
                      <div><span className="meta-label">Model</span><strong>{selectedTrackedVehicleLookup.model || '—'}</strong></div>
                      <div><span className="meta-label">Colour</span><strong>{selectedTrackedVehicleLookup.color || '—'}</strong></div>
                      <div><span className="meta-label">Body</span><strong>{selectedTrackedVehicleLookup.bodyType || '—'}</strong></div>
                      <div><span className="meta-label">Fuel</span><strong>{selectedTrackedVehicleLookup.fuelType || '—'}</strong></div>
                      <div><span className="meta-label">MOT</span><strong>{selectedTrackedVehicleLookup.motStatus || '—'}</strong></div>
                      <div><span className="meta-label">MOT expiry</span><strong>{selectedTrackedVehicleLookup.motExpiry || '—'}</strong></div>
                      <div><span className="meta-label">Tax</span><strong>{selectedTrackedVehicleLookup.taxStatus || '—'}</strong></div>
                    </div>
                  ) : null}
                </div>

                {/* PCN conversion */}
                <div className="border-top-subtle">
                  <p className="detail-section-label">PCN escalation</p>
                  <div className="detail-grid">
                    <label>
                      PCN number
                      <input value={pcnNumberInput} onChange={(e) => setPcnNumberInput(e.target.value)} placeholder="PCN-XXXX" />
                    </label>
                    <label>
                      Amount (GBP)
                      <input type="number" min="1" step="1" value={pcnAmountInput} onChange={(e) => setPcnAmountInput(e.target.value)} />
                    </label>
                  </div>
                  <label>
                    PCN reason
                    <textarea rows={2} value={pcnReasonInput} onChange={(e) => setPcnReasonInput(e.target.value)} />
                  </label>
                  {convertError ? <div className="notice notice-error" style={{ marginTop: 8 }}>{convertError}</div> : null}
                  <div className="inline-actions" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="primary-button"
                      style={{ padding: '10px 18px' }}
                      onClick={handleConvertToPcn}
                      disabled={convertLoading || selectedTracked.lifecycle.code !== 'SUBMITTED' || selectedTracked?.payload?.convertedToPcn}
                    >
                      {selectedTracked?.payload?.convertedToPcn ? 'Already converted' : convertLoading ? 'Converting…' : 'Convert to PCN'}
                    </button>
                    <span className="text-muted">Only available once breach is submitted.</span>
                  </div>
                </div>

                {/* Danger zone */}
                <div className="border-top-subtle">
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="ghost-button ghost-danger"
                      style={{ fontSize: '13px' }}
                      onClick={() => handleCancelTracked(selectedTracked.id)}
                    >
                      Remove breach
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="card" style={{ display: 'grid', placeItems: 'center', minHeight: 220 }}>
                <p className="card-copy" style={{ textAlign: 'center' }}>Select a breach from the list to view details and evidence.</p>
              </div>
            )}
          </section>
        ) : null}

        {activeTab === 'queue' ? (
          <section className="workspace-grid">
            <div className="card stack gap-large wide-card">
              <div className="card-header-row">
                <div>
                  <p className="eyebrow">Queue</p>
                  <h3>Offline sync status</h3>
                </div>
                <span className="muted-chip">{syncCandidates.length} ready/syncing</span>
              </div>

              {syncCandidates.length === 0 ? (
                <p className="card-copy">The queue is empty. Captures are stored locally when connectivity drops.</p>
              ) : (
                <div className="queue-list">
                  {syncCandidates.map((item) => (
                    <article key={item.id} className="queue-item">
                      <div>
                        <strong>{item.vrm || 'Pending VRM'}</strong>
                        <p>{item.reason || 'No reason supplied'}</p>
                        <span>{item.siteName || 'Site not set'}</span>
                      </div>
                      <div className="queue-item-meta">
                        <span className={`status-pill ${item.status === 'failed' ? 'status-pill-offline' : 'status-pill-online'}`}>{item.status}</span>
                        <span>{new Date(item.createdAt).toLocaleString()}</span>
                        <div className="inline-actions">
                          <button type="button" className="secondary-button" onClick={() => handleRetryTracked(item.id)} disabled={syncing}>
                            Retry
                          </button>
                          <button type="button" className="ghost-button ghost-danger" onClick={() => handleCancelTracked(item.id)}>
                            Remove
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="card stack gap-large wide-card">
              <div className="card-header-row">
                <div>
                  <p className="eyebrow">Observation timers</p>
                  <h3>Vehicles currently under timing</h3>
                </div>
                <span className="muted-chip">{activeTimers.length} active</span>
              </div>
              {activeTimers.length === 0 ? (
                <p className="card-copy">No active observation timers yet.</p>
              ) : (
                <div className="timer-list">
                  {activeTimers.map((timer) => (
                    <article key={timer.id} className="timer-item">
                      <div>
                        <strong>{timer.vrm}</strong>
                        <p>{timer.reason}</p>
                        <span>{timer.siteName}</span>
                      </div>
                      <div className="timer-countdown">{formatCountdown(timer.endsAt)}</div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : null}
      </section>

      {/* Floating Action Button (FAB) for new breaches */}
      <button
        type="button"
        className="fab-new-breach"
        onClick={() => setStepperOpen(true)}
        aria-label="New breach"
        title="Create new breach session"
      >
        +
      </button>

      {/* 3-step creation stepper */}
      <BreachStepper
        open={stepperOpen}
        onClose={() => setStepperOpen(false)}
        onComplete={handleStepperComplete}
        sites={sites}
        contraventions={contraventions}
        selectedSiteId={selectedSiteId}
      />
    </AppShell>
  );
}