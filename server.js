const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new ApifyClient({
    token: process.env.APIFY_TOKEN
});

// ---------- EXISTING: single-carrier lookup by name/DOT/MC (still via Apify) ----------
app.get('/api/search-trucking', async (req, res) => {
    try {
        const { companyName } = req.query;
        if (!companyName) {
            return res.status(400).json({ error: 'Company name parameter is required.' });
        }
        const run = await client.actor("makework36/fmcsa-trucking-api").call({
            searchMode: "byName",
            companyName: companyName,
            maxResults: 20,
            enrichWithWebSearch: true
        });
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        res.json(items);
    } catch (error) {
        console.error('Apify Proxy Error:', error.message);
        res.status(500).json({ error: 'Failed to query the cloud trucking database.' });
    }
});

// ---------- NEW: combinable filter search, direct from FMCSA's Socrata dataset ----------
// No Apify, no per-record cost - this queries data.transportation.gov directly.
// Dataset: Company Census File (az4n-8mr2) - all field names below verified against
// the live column schema, not guessed from the PDF data dictionary.
const SOCRATA_BASE_URL = 'https://data.transportation.gov/resource/az4n-8mr2.json';

function escapeSoQLString(val) {
    return String(val).replace(/'/g, "''");
}

// Maps a friendly cargoType query value to its real column name.
// Every value here was confirmed against the dataset's actual schema.
const CARGO_TYPE_MAP = {
    generalfreight: 'crgo_genfreight',
    household: 'crgo_household',
    metalsheet: 'crgo_metalsheet',
    motorvehicles: 'crgo_motoveh',
    drivetow: 'crgo_drivetow',
    logpole: 'crgo_logpole',
    buildingmaterials: 'crgo_bldgmat',
    mobilehome: 'crgo_mobilehome',
    machinery: 'crgo_machlrg',
    produce: 'crgo_produce',
    liquidsgases: 'crgo_liqgas',
    intermodal: 'crgo_intermodal',
    passengers: 'crgo_passengers',
    oilfield: 'crgo_oilfield',
    livestock: 'crgo_livestock',
    grainfeed: 'crgo_grainfeed',
    coalcoke: 'crgo_coalcoke',
    meat: 'crgo_meat',
    garbage: 'crgo_garbage',
    usmail: 'crgo_usmail',
    chemicals: 'crgo_chem',
    drybulk: 'crgo_drybulk',
    refrigerated: 'crgo_coldfood',
    beverages: 'crgo_beverages',
    paperproducts: 'crgo_paperprod',
    utility: 'crgo_utility',
    farmsupplies: 'crgo_farmsupp',
    construction: 'crgo_construct',
    waterwell: 'crgo_waterwell',
    other: 'crgo_cargoothr'
};

app.get('/api/census-search', async (req, res) => {
    try {
        const {
            state,
            carrierOperation,
            hazmat,
            minPowerUnits,
            maxPowerUnits,
            minTruckUnits,
            maxTruckUnits,
            excludeBuses,
            minDrivers,
            maxDrivers,
            businessOrgDesc,
            classContains,
            minMileage,
            maxMileage,
            city,
            zipPrefix,
            minOwnTrucks,      // owntruck - owned straight trucks
            maxOwnTrucks,
            minOwnTractors,    // owntract - owned tractors (semi trucks)
            maxOwnTractors,
            minOwnTrailers,    // owntrail - owned trailers
            maxOwnTrailers,
            cargoType,         // one key from CARGO_TYPE_MAP above
            status,
            mcs150After,
            mcs150Before,
            sortBy,
            maxResults
        } = req.query;

        if (!state && !carrierOperation && !hazmat) {
            return res.status(400).json({
                error: 'At least one of state, carrierOperation, or hazmat is required.'
            });
        }

        if (cargoType && !CARGO_TYPE_MAP[cargoType]) {
            return res.status(400).json({
                error: `Invalid cargoType. Valid options: ${Object.keys(CARGO_TYPE_MAP).join(', ')}`
            });
        }

        const targetCount = Math.min(parseInt(maxResults, 10) || 500, 1000);

        const conditions = [];
        if (state) conditions.push(`phy_state = '${escapeSoQLString(state.toUpperCase())}'`);
        if (carrierOperation) conditions.push(`carrier_operation = '${escapeSoQLString(carrierOperation.toUpperCase())}'`);
        if (hazmat === 'true') conditions.push(`hm_ind = 'Y'`);

        const statusFilter = (status || 'active').toLowerCase();
        if (statusFilter === 'active') conditions.push(`status_code = 'A'`);
        else if (statusFilter === 'inactive') conditions.push(`status_code = 'I'`);
        else if (statusFilter === 'pending') conditions.push(`status_code = 'P'`);

        if (minPowerUnits) conditions.push(`power_units >= ${parseInt(minPowerUnits, 10)}`);
        if (maxPowerUnits) conditions.push(`power_units <= ${parseInt(maxPowerUnits, 10)}`);
        if (minTruckUnits) conditions.push(`truck_units >= ${parseInt(minTruckUnits, 10)}`);
        if (maxTruckUnits) conditions.push(`truck_units <= ${parseInt(maxTruckUnits, 10)}`);
        if (excludeBuses === 'true') conditions.push(`bus_units = 0`);
        if (minDrivers) conditions.push(`total_drivers >= ${parseInt(minDrivers, 10)}`);
        if (maxDrivers) conditions.push(`total_drivers <= ${parseInt(maxDrivers, 10)}`);
        if (businessOrgDesc) conditions.push(`upper(business_org_desc) like upper('%${escapeSoQLString(businessOrgDesc)}%')`);
        if (classContains) conditions.push(`upper(classdef) like upper('%${escapeSoQLString(classContains)}%')`);
        if (minMileage) conditions.push(`mcs150_mileage >= ${parseInt(minMileage, 10)}`);
        if (maxMileage) conditions.push(`mcs150_mileage <= ${parseInt(maxMileage, 10)}`);
        if (city) conditions.push(`upper(phy_city) like upper('%${escapeSoQLString(city)}%')`);
        if (zipPrefix) conditions.push(`starts_with(phy_zip, '${escapeSoQLString(zipPrefix)}')`);
        if (minOwnTrucks) conditions.push(`owntruck >= ${parseInt(minOwnTrucks, 10)}`);
        if (maxOwnTrucks) conditions.push(`owntruck <= ${parseInt(maxOwnTrucks, 10)}`);
        if (minOwnTractors) conditions.push(`owntract >= ${parseInt(minOwnTractors, 10)}`);
        if (maxOwnTractors) conditions.push(`owntract <= ${parseInt(maxOwnTractors, 10)}`);
        if (minOwnTrailers) conditions.push(`owntrail >= ${parseInt(minOwnTrailers, 10)}`);
        if (maxOwnTrailers) conditions.push(`owntrail <= ${parseInt(maxOwnTrailers, 10)}`);
        if (cargoType) conditions.push(`${CARGO_TYPE_MAP[cargoType]} = 'X'`);
        if (mcs150After) conditions.push(`mcs150_date >= '${escapeSoQLString(mcs150After)}T00:00:00'`);
        if (mcs150Before) conditions.push(`mcs150_date <= '${escapeSoQLString(mcs150Before)}T23:59:59'`);

        const sortMode = (sortBy || 'recent').toLowerCase();
        const orderClause = sortMode === 'none' ? '' : `mcs150_date ${sortMode === 'oldest' ? 'ASC' : 'DESC'}`;
        if (sortMode !== 'none') conditions.push(`mcs150_date IS NOT NULL`);

        const params = new URLSearchParams();
        params.set('$where', conditions.join(' AND '));
        params.set('$limit', targetCount.toString());
        if (orderClause) params.set('$order', orderClause);

        const url = `${SOCRATA_BASE_URL}?${params.toString()}`;

        const socrataRes = await fetch(url, {
            headers: { 'X-App-Token': process.env.SOCRATA_APP_TOKEN }
        });

        if (!socrataRes.ok) {
            const errText = await socrataRes.text();
            console.error('Socrata API Error:', socrataRes.status, errText);
            return res.status(502).json({ error: 'Failed to query the FMCSA census database.' });
        }

        const items = await socrataRes.json();

        res.json({
            count: items.length,
            requestedFilters: {
                state, carrierOperation, hazmat, minPowerUnits, maxPowerUnits,
                minTruckUnits, maxTruckUnits, excludeBuses, minDrivers, maxDrivers,
                businessOrgDesc, classContains, minMileage, maxMileage, city, zipPrefix,
                minOwnTrucks, maxOwnTrucks, minOwnTractors, maxOwnTractors,
                minOwnTrailers, maxOwnTrailers, cargoType,
                status: statusFilter, mcs150After, mcs150Before
            },
            results: items
        });

    } catch (error) {
        console.error('Census Search Error:', error.message);
        res.status(500).json({ error: 'Failed to query the FMCSA census database.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
