
/**
 * PrintsHub — Land Map Backend Server
 * ─────────────────────────────────────
 * Routes:
 *  GET  /api/districts          → All Maharashtra districts
 *  GET  /api/talukas/:distCode  → Talukas for a district
 *  GET  /api/villages/:talukaCode → Villages for a taluka
 *  POST /api/map                → Fetch KML from BhuNaksha + return GeoJSON
 *  GET  /api/lgd/sync           → Sync latest village list from LGD/data.gov.in
 *
 * Install: npm install express cors axios node-cache xml2js
 * Run:     node server.js
 */

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const NodeCache = require('node-cache');
const xml2js    = require('xml2js');
const path      = require('path');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1hr cache

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// BhuNaksha District Codes (Maharashtra = state code 27)
// Full list: https://mahabhunakasha.mahabhumi.gov.in
// ─────────────────────────────────────────────────────────────────────────────
const DISTRICT_CODES = {
  "Ahmednagar":  "001", "Akola":       "002", "Amravati":    "003",
  "Aurangabad":  "004", "Beed":        "005", "Bhandara":    "006",
  "Buldhana":    "007", "Chandrapur":  "008", "Dhule":       "009",
  "Gadchiroli":  "010", "Gondia":      "011", "Hingoli":     "012",
  "Jalgaon":     "013", "Jalna":       "014", "Kolhapur":    "015",
  "Latur":       "016", "Mumbai City": "017", "Mumbai Suburban":"018",
  "Nagpur":      "019", "Nanded":      "020", "Nandurbar":   "021",
  "Nashik":      "022", "Osmanabad":   "023", "Palghar":     "024",
  "Parbhani":    "025", "Pune":        "026", "Raigad":      "027",
  "Ratnagiri":   "028", "Sangli":      "029", "Satara":      "030",
  "Sindhudurg":  "031", "Solapur":     "032", "Thane":       "033",
  "Wardha":      "034", "Washim":      "035", "Yavatmal":    "036"
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: Districts list
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/districts', (req, res) => {
  const districts = Object.keys(DISTRICT_CODES).map(name => ({
    name,
    code: DISTRICT_CODES[name]
  }));
  res.json({ success: true, data: districts });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2: Talukas for a district
// Source: BhuNaksha dropdown API (reverse-engineered)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/talukas/:distCode', async (req, res) => {
  const { distCode } = req.params;
  const cacheKey = `talukas_${distCode}`;

  // Return from cache if available
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    // BhuNaksha taluka endpoint
    const url = `https://mahabhunakasha.mahabhumi.gov.in/bhunaksha/27/Talukas?stateCode=27&districtCode=${distCode}`;
    const response = await axios.get(url, {
      headers: {
        'Referer': 'https://mahabhunakasha.mahabhumi.gov.in/',
        'User-Agent': 'Mozilla/5.0 (compatible; PrintsHub/1.0)'
      },
      timeout: 8000
    });

    // BhuNaksha returns: [{"id":"1","name":"Haveli"}, ...]
    const talukas = response.data;
    cache.set(cacheKey, talukas);
    res.json({ success: true, data: talukas, source: 'bhunaksha' });

  } catch (err) {
    console.error('Taluka fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3: Villages for a taluka
// Source: BhuNaksha village dropdown + LGD fallback
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/villages/:distCode/:talukaCode', async (req, res) => {
  const { distCode, talukaCode } = req.params;
  const cacheKey = `villages_${distCode}_${talukaCode}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    // BhuNaksha village endpoint
    const url = `https://mahabhunakasha.mahabhumi.gov.in/bhunaksha/27/Villages?stateCode=27&districtCode=${distCode}&talukaCode=${talukaCode}`;
    const response = await axios.get(url, {
      headers: {
        'Referer': 'https://mahabhunakasha.mahabhumi.gov.in/',
        'User-Agent': 'Mozilla/5.0 (compatible; PrintsHub/1.0)'
      },
      timeout: 8000
    });

    const villages = response.data;
    cache.set(cacheKey, villages);
    res.json({ success: true, data: villages, source: 'bhunaksha' });

  } catch (err) {
    console.error('Village fetch error:', err.message);

    // Fallback: try LGD data.gov.in API
    try {
      const lgdData = await fetchLGDVillages(distCode, talukaCode);
      res.json({ success: true, data: lgdData, source: 'lgd_fallback' });
    } catch (lgdErr) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4: Fetch KML from BhuNaksha → Convert to GeoJSON
// This is the MAIN proxy — browser can't call BhuNaksha directly (CORS)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/map', async (req, res) => {
  const { distCode, talukaCode, villageCode, surveyNo } = req.body;

  // Validate inputs
  if (!distCode || !talukaCode || !villageCode || !surveyNo) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  const cacheKey = `map_${distCode}_${talukaCode}_${villageCode}_${surveyNo}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    // ── Step 1: Get plot info from BhuNaksha ─────────────────────────────────
    const plotInfoUrl = `https://mahabhunakasha.mahabhumi.gov.in/bhunaksha/27/PlotInfo?` +
      `stateCode=27&districtCode=${distCode}&talukaCode=${talukaCode}` +
      `&villageCode=${villageCode}&surveyNo=${encodeURIComponent(surveyNo)}`;

    const plotResponse = await axios.get(plotInfoUrl, {
      headers: {
        'Referer': 'https://mahabhunakasha.mahabhumi.gov.in/',
        'User-Agent': 'Mozilla/5.0 (compatible; PrintsHub/1.0)',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: 10000
    });

    // ── Step 2: Get KML boundary ──────────────────────────────────────────────
    const kmlUrl = `https://mahabhunakasha.mahabhumi.gov.in/bhunaksha/27/KMLDownload?` +
      `stateCode=27&districtCode=${distCode}&talukaCode=${talukaCode}` +
      `&villageCode=${villageCode}&surveyNo=${encodeURIComponent(surveyNo)}`;

    const kmlResponse = await axios.get(kmlUrl, {
      headers: {
        'Referer': 'https://mahabhunakasha.mahabhumi.gov.in/',
        'User-Agent': 'Mozilla/5.0 (compatible; PrintsHub/1.0)'
      },
      timeout: 10000,
      responseType: 'text'
    });

    // ── Step 3: Parse KML → GeoJSON ───────────────────────────────────────────
    const geojson = await parseKMLtoGeoJSON(kmlResponse.data, plotResponse.data, surveyNo);

    cache.set(cacheKey, geojson, 86400); // Cache 24hrs (land data rarely changes)
    res.json({ success: true, data: geojson, source: 'bhunaksha_live' });

  } catch (err) {
    console.error('Map fetch error:', err.message);
    res.status(500).json({
      success: false,
      error: 'BhuNaksha वरून data मिळवता आला नाही. थोड्या वेळाने पुन्हा प्रयत्न करा.',
      detail: err.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 5: LGD Sync — Fetch latest village master from data.gov.in
// Run this once/week to keep village list updated
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/lgd/sync', async (req, res) => {
  try {
    // LGD API on data.gov.in — Maharashtra villages
    // Replace YOUR_API_KEY with key from data.gov.in
    const LGD_API_KEY = process.env.LGD_API_KEY || 'YOUR_API_KEY';
    const lgdUrl = `https://api.data.gov.in/resource/9115b89c-7a80-4f54-9b06-21086e0f0bd3` +
      `?api-key=${LGD_API_KEY}&format=json&filters[statecode]=27&limit=50000`;

    const response = await axios.get(lgdUrl, { timeout: 30000 });
    const records  = response.data.records || [];

    // Save to cache (or database in production)
    cache.set('lgd_villages_mah', records, 604800); // 7 days
    res.json({ success: true, count: records.length, message: 'LGD sync complete' });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Parse KML XML → GeoJSON
// BhuNaksha returns KML with <Placemark> containing coordinates
// ─────────────────────────────────────────────────────────────────────────────
async function parseKMLtoGeoJSON(kmlText, plotInfo, surveyNo) {
  const parser  = new xml2js.Parser({ explicitArray: false });
  const parsed  = await parser.parseStringPromise(kmlText);

  const features = [];

  // Navigate KML structure: kml → Document → Folder → Placemark
  const doc       = parsed?.kml?.Document;
  const folder    = doc?.Folder;
  const placemarks = Array.isArray(folder?.Placemark)
    ? folder.Placemark
    : folder?.Placemark ? [folder.Placemark] : [];

  for (const pm of placemarks) {
    // Extract coordinates from Polygon or MultiGeometry
    let coordinates = null;

    if (pm?.Polygon?.outerBoundaryIs?.LinearRing?.coordinates) {
      coordinates = parseCoords(pm.Polygon.outerBoundaryIs.LinearRing.coordinates);
    } else if (pm?.MultiGeometry?.Polygon) {
      const polys = Array.isArray(pm.MultiGeometry.Polygon)
        ? pm.MultiGeometry.Polygon : [pm.MultiGeometry.Polygon];
      coordinates = polys.map(p =>
        parseCoords(p.outerBoundaryIs.LinearRing.coordinates)
      );
    }

    if (!coordinates) continue;

    // Extract SimpleData fields from ExtendedData
    const extData  = pm?.ExtendedData?.SchemaData?.SimpleData;
    const dataMap  = {};
    if (Array.isArray(extData)) {
      extData.forEach(d => { dataMap[d.$.name] = d._; });
    }

    features.push({
      type: 'Feature',
      properties: {
        surveyNo:   surveyNo,
        khateNo:    dataMap.khata_no     || plotInfo?.khataNo    || '—',
        ownerName:  dataMap.owner_name   || plotInfo?.ownerName  || '—',
        area:       dataMap.area_hect    || plotInfo?.area       || '—',
        landType:   dataMap.land_type    || plotInfo?.landType   || '—',
        village:    dataMap.village_name || plotInfo?.villageName || '—',
      },
      geometry: {
        type: coordinates[0]?.[0]?.length ? 'MultiPolygon' : 'Polygon',
        coordinates: coordinates
      }
    });
  }

  return { type: 'FeatureCollection', features };


function parseCoords(coordString) {
  return [coordString.trim().split(/\s+/).map(c => {
    const parts = c.split(',');
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  })];
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: LGD fallback villages fetch
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLGDVillages(distCode, talukaCode) {
  const cached = cache.get('lgd_villages_mah');
  if (cached) {
    return cached
      .filter(r => r.districtcode === distCode && r.talukacode === talukaCode)
      .map(r => ({ id: r.villagecode, name: r.villagename_english, nameMarathi: r.villagename }));
  }
  throw new Error('LGD data not synced');
}

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ PrintsHub Map Server running on http://localhost:${PORT}`);
  console.log(`   API endpoints:`);
  console.log(`   GET  /api/districts`);
  console.log(`   GET  /api/talukas/:distCode`);
  console.log(`   GET  /api/villages/:distCode/:talukaCode`);
  console.log(`   POST /api/map  { distCode, talukaCode, villageCode, surveyNo }`);
  console.log(`   GET  /api/lgd/sync  (needs LGD_API_KEY env var)\n`);
});
