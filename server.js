// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors'); // Import cors middleware
const db = require('./db'); // Import our PostgreSQL client setup

const app = express();
const PORT = process.env.PORT || 5000; // Use the existing PORT variable

// Middleware
app.use(cors()); // Enable CORS for all routes (important for React frontend to connect)
app.use(express.json()); // Parse JSON request bodies

// --- Helper Functions (Existing from Referral App) ---

// Haversine distance function (in kilometers)
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of Earth in kilometers
    const toRadians = (deg) => deg * (Math.PI / 180);

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// Facility hierarchy definition (ordered from lowest to highest)
const facilityHierarchyOrder = [
    'SUB_CEN',
    'PHC',
    'CHC',
    'S_T_H',
    'District Hospital',
    'Medical College'
];

// --- API Endpoints (From Referral App) ---

// 1. Get all unique states (for Referral App)
app.get('/api/states', async (req, res) => {
    try {
        const result = await db.query('SELECT DISTINCT "StateName" FROM "HealthcareFacilities" ORDER BY "StateName";');
        res.json(result.rows.map(row => row.StateName));
    } catch (err) {
        console.error('Error fetching states (Referral):', err);
        res.status(500).json({ error: 'Failed to fetch states' });
    }
});

// 2. Get all unique districts for a given state (for Referral App)
app.get('/api/districts/:stateName', async (req, res) => {
    const { stateName } = req.params;
    try {
        const result = await db.query(
            'SELECT DISTINCT "DistrictName" FROM "HealthcareFacilities" WHERE "StateName" = $1 ORDER BY "DistrictName";',
            [stateName]
        );
        res.json(result.rows.map(row => row.DistrictName));
    } catch (err) {
        console.error('Error fetching districts (Referral):', err);
        res.status(500).json({ error: 'Failed to fetch districts' });
    }
});

// 3. Get all unique subdistricts for a given state and district (for Referral App)
app.get('/api/subdistricts/:stateName/:districtName', async (req, res) => {
    const { stateName, districtName } = req.params;
    try {
        const result = await db.query(
            'SELECT DISTINCT "SubdistrictName" FROM "HealthcareFacilities" WHERE "StateName" = $1 AND "DistrictName" = $2 ORDER BY "SubdistrictName";',
            [stateName, districtName]
        );
        const subdistricts = result.rows
            .map(row => row.SubdistrictName)
            .filter(name => name !== null && name !== '')
            .sort();
        res.json(subdistricts);
    } catch (err) {
        console.error('Error fetching subdistricts (Referral):', err);
        res.status(500).json({ error: 'Failed to fetch subdistricts' });
    }
});

// 4. Get all unique facility names for a given state, district, and subdistrict (for Referral App)
app.get('/api/facilities/:stateName/:districtName/:subdistrictName', async (req, res) => {
    const { stateName, districtName, subdistrictName } = req.params;
    try {
        const result = await db.query(
            'SELECT "FacilityName" FROM "HealthcareFacilities" WHERE "StateName" = $1 AND "DistrictName" = $2 AND "SubdistrictName" = $3 ORDER BY "FacilityName";',
            [stateName, districtName, subdistrictName]
        );
        res.json(result.rows.map(row => row.FacilityName));
    } catch (err) {
        console.error('Error fetching facilities (Referral):', err);
        res.status(500).json({ error: 'Failed to fetch facilities' });
    }
});

// 5. Referral Endpoint: Find closest next-level facilities (for Referral App)
app.post('/api/referral', async (req, res) => {
    const { selectedState, selectedDistrict, selectedSubdistrict, selectedFacilityName } = req.body;

    if (!selectedState || !selectedDistrict || !selectedSubdistrict || !selectedFacilityName) {
        return res.status(400).json({ error: 'Please provide all selection parameters: state, district, subdistrict, and facility name.' });
    }

    try {
        const startFacilityResult = await db.query(
            `SELECT * FROM "HealthcareFacilities"
             WHERE "StateName" = $1 AND "DistrictName" = $2 AND "SubdistrictName" = $3 AND "FacilityName" = $4;`,
            [selectedState, selectedDistrict, selectedSubdistrict, selectedFacilityName]
        );

        if (startFacilityResult.rows.length === 0) {
            return res.status(404).json({ error: `Starting facility '${selectedFacilityName}' not found.` });
        }
        const startFacility = startFacilityResult.rows[0];

        const startLat = parseFloat(startFacility.latitude);
        const startLon = parseFloat(startFacility.longitude);
        const startType = startFacility.FacilityType;
        const startDistrict = startFacility.DistrictName;

        if (isNaN(startLat) || isNaN(startLon)) {
             return res.status(500).json({ error: `Starting facility (${startFacility.FacilityName}) has invalid geographic coordinates: Lat='${startFacility.latitude}', Lon='${startFacility.longitude}'.` });
        }

        const startIndex = facilityHierarchyOrder.indexOf(startType);
        if (startIndex === -1) {
            return res.status(400).json({ error: `'${startType}' is not a recognized facility type in the hierarchy.` });
        }

        const higherLevelTypes = facilityHierarchyOrder.slice(startIndex + 1);

        if (higherLevelTypes.length === 0) {
            return res.status(400).json({ error: `'${startType}' is the highest level facility in the hierarchy, no higher levels to refer to.` });
        }

        const queryParams = [startDistrict, ...higherLevelTypes];
        const nextLevelFacilitiesResult = await db.query(
            `SELECT * FROM "HealthcareFacilities"
             WHERE "DistrictName" = $1 AND "FacilityType" IN (${higherLevelTypes.map((_, i) => `$${i + 2}`).join(', ')});`,
            queryParams
        );

        if (nextLevelFacilitiesResult.rows.length === 0) {
            return res.status(404).json({ error: `No higher level facilities found in the same district (${startDistrict}).` });
        }

        let distances = nextLevelFacilitiesResult.rows.map(f => {
            const fLat = parseFloat(f.latitude);
            const fLon = parseFloat(f.longitude);

            if (isNaN(fLat) || isNaN(fLon)) {
                console.warn(`[WARN] Skipping facility ${f.FacilityName} due to invalid coordinates: Lat='${f.latitude}', Lon='${f.longitude}'`);
                return null;
            }

            const dist = haversineDistance(startLat, startLon, fLat, fLon);
            return {
                'Facility Name': f.FacilityName,
                'Distance (km)': dist,
                'Facility Type': f.FacilityType,
                'State Name': f.StateName,
                'District Name': f.DistrictName,
                'Latitude': fLat,
                'Longitude': fLon
            };
        }).filter(item => item !== null);


        distances.sort((a, b) => a['Distance (km)'] - b['Distance (km)']);

        const top5Distances = distances.slice(0, 5);


        res.json({
            startFacility: {
                'Facility Name': startFacility.FacilityName,
                'Facility Type': startFacility.FacilityType,
                'District Name': startFacility.DistrictName,
                'Latitude': parseFloat(startFacility.latitude),
                'Longitude': parseFloat(startFacility.longitude)
            },
            closestNextLevelFacility: top5Distances[0] || null,
            allNextLevelFacilities: top5Distances
        });

    } catch (err) {
        console.error('Error during referral calculation:', err);
        res.status(500).json({ error: 'Failed to process referral request' });
    }
});


// --- API Endpoints (From Health KPI Dashboard App - MODIFIED TO USE 'db' AND '/kpi' PREFIX) ---

/**
 * @route GET /api/kpi/states
 * @description Get a list of all distinct states from the districts table (for KPI).
 * @returns {Array<Object>} [{ "state_name": "State1" }, { "state_name": "State2" }]
 */
app.get('/api/kpi/states', async (req, res) => {
    try {
        const result = await db.query('SELECT DISTINCT state_name FROM districts ORDER BY state_name;');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching states (KPI):', err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
});

/**
 * @route GET /api/kpi/districts
 * @description Get a list of districts for a given state (for KPI).
 * @param {string} req.query.state - The state name.
 * @returns {Array<Object>} [{ "district_id": 1, "district_name": "District1" }, ...]
 */
app.get('/api/kpi/districts', async (req, res) => {
    const { state } = req.query;
    if (!state) {
        return res.status(400).json({ error: 'State parameter is required.' });
    }
    try {
        const query = `
            SELECT district_id, district_name
            FROM districts
            WHERE state_name = $1
            ORDER BY district_name;
        `;
        const result = await db.query(query, [state]);
        res.json(result.rows);
    } catch (err) {
        console.error(`Error fetching districts for state ${state} (KPI):`, err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
});

/**
 * @route GET /api/kpi/available-sources
 * @description Get a list of available data sources (e.g., 'HMIS Data', 'NFHS 2019') for a given district (for KPI).
 * @param {number} req.query.districtId - The ID of the district.
 * @returns {Array<string>} ["HMIS Data", "NFHS 2019"]
 */
app.get('/api/kpi/available-sources', async (req, res) => {
    const { districtId } = req.query;
    if (!districtId) {
        return res.status(400).json({ error: 'districtId parameter is required.' });
    }
    try {
        const query = `
            SELECT DISTINCT kd.source
            FROM health_kpis hk
            JOIN kpi_definitions kd ON hk.kpi_id = kd.kpi_id
            WHERE hk.district_id = $1
            ORDER BY kd.source;
        `;
        const result = await db.query(query, [districtId]);
        const sources = result.rows.map(row => row.source);
        res.json(sources);
    } catch (err) {
        console.error(`Error fetching available sources for district ${districtId} (KPI):`, err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
});

/**
 * @route GET /api/kpi/available-years
 * @description Get a list of unique years for a specific district and data source (for KPI).
 * @param {number} req.query.districtId - The ID of the district.
 * @param {string} req.query.source - The data source (e.g., 'HMIS Data', 'NFHS 2019').
 * @returns {Array<number>} [2018, 2019, 2020]
 */
app.get('/api/kpi/available-years', async (req, res) => {
    const { districtId, source } = req.query;
    if (!districtId || !source) {
        return res.status(400).json({ error: 'districtId and source parameters are required.' });
    }
    try {
        const query = `
            SELECT DISTINCT hk.year
            FROM health_kpis hk
            JOIN kpi_definitions kd ON hk.kpi_id = kd.kpi_id
            WHERE hk.district_id = $1 AND kd.source = $2
            ORDER BY hk.year DESC;
        `;
        const result = await db.query(query, [districtId, source]);
        const years = result.rows.map(row => row.year);
        res.json(years);
    } catch (err) {
        console.error(`Error fetching available years for district ${districtId} and source ${source} (KPI):`, err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
});

/**
 * @route GET /api/kpi/kpi-data
 * @description Fetch KPI values and their definitions (including category) for a specific district, source, and year (for KPI).
 * @param {number} req.query.districtId - The ID of the district.
 * @param {string} req.query.source - The data source.
 * @param {number} req.query.year - The year.
 * @returns {Array<Object>} [{ "kpi_id": ..., "kpi_name": "...", "kpi_value": ..., "unit": "...", "description": "...", "category": "..." }, ...]
 */
app.get('/api/kpi/kpi-data', async (req, res) => {
    const { districtId, source, year } = req.query;
    if (!districtId || !source || !year) {
        return res.status(400).json({ error: 'districtId, source, and year parameters are required.' });
    }
    try {
        const query = `
            SELECT
                hk.kpi_id,
                hk.kpi_value,
                hk.year,
                kd.kpi_name,
                kd.unit,
                kd.description,
                kd.category,
                d.district_name,
                d.state_name,
                d.country_name
            FROM
                health_kpis hk
            JOIN
                kpi_definitions kd ON hk.kpi_id = kd.kpi_id
            JOIN
                districts d ON hk.district_id = d.district_id
            WHERE
                hk.district_id = $1 AND kd.source = $2 AND hk.year = $3
            ORDER BY
                kd.category, kd.kpi_name;
        `;
        const result = await db.query(query, [districtId, source, year]);
        res.json(result.rows);
    } catch (err) {
        console.error(`Error fetching KPI data for district ${districtId}, source ${source}, year ${year} (KPI):`, err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
});

/**
 * @route GET /api/kpi/kpi-definitions
 * @description Get all KPI definitions (for KPI).
 * @returns {Array<Object>} [{ "kpi_id": ..., "kpi_name": "...", "unit": "...", "source": "...", "description": "...", "category": "..." }, ...]
 */
app.get('/api/kpi/kpi-definitions', async (req, res) => {
    try {
        const query = `
            SELECT kpi_id, kpi_name, unit, source, description, category
            FROM kpi_definitions
            ORDER BY kpi_name;
        `;
        const result = await db.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching KPI definitions (KPI):', err.message);
        res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
});


// Basic route for testing server status
app.get('/', (req, res) => {
    res.send('Healthcare Referral API is running!');
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API accessible at http://localhost:${PORT}`);
    console.log(`Referral API endpoints: /api/states, /api/districts/:stateName, /api/subdistricts/:stateName/:districtName, /api/facilities/:stateName/:districtName/:subdistrictName, /api/referral (POST)`);
    console.log(`KPI API endpoints: /api/kpi/states, /api/kpi/districts, /api/kpi/available-sources, /api/kpi/available-years, /api/kpi/kpi-data, /api/kpi/kpi-definitions`);
});
