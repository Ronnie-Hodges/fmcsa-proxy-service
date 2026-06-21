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
// Dataset: Company Census File (az4n-8mr2)
const SOCRATA_BASE_URL = 'https://data.transportation.gov/resource/az4n-8mr2.json';

function escapeSoQLString(val) {
    // Prevent SoQL injection by doubling single quotes, same idea as SQL escaping
    return String(val).replace(/'/g, "''");
}

app.get('/api/census-search', async (req, res) => {
    try {
        const {
            state,             // e.g. "GA" - real filter
            carrierOperation,  // "A" = Authorized for Hire, "B" = Exempt, "C" = Private
            hazmat,            // "true" / "false"
            minPowerUnits,
            maxPowerUnits,
            minTruckUnits,
            maxTruckUnits,
            excludeBuses,      // "true" - only carriers with 0 bus_units
            minDrivers,
            maxDrivers,
            businessOrgDesc,   // "INDIVIDUAL" or "CORPORATION" - partial match
            classContains,     // free-text match against classdef (e.g. "EXEMPT", "PRIVATE")
            minMileage,
            maxMileage,
            city,              // partial match
            zipPrefix,         // e.g. "300" matches all 300xx zips
            status,            // "active" (default), "inactive", or "all"
            mcs150After,       // YYYY-MM-DD
            mcs150Before,      // YYYY-MM-DD
            sortBy,            // "recent" (default), "oldest", or "none"
            maxResults
        } = req.query;

        // Require at least one real filter so we never accidentally pull the whole 4.4M file
        if (!state && !carrierOperation && !hazmat) {
            return res.status(400).json({
                error: 'At least one of state, carrierOperation, or hazmat is required.'
            });
        }

        const targetCount = Math.min(parseInt(maxResults, 10) || 500, 1000);

        // Every filter below runs as a real SoQL $where condition - Socrata filters
        // server-side, so there's no need to over-fetch and filter in JavaScript.
        const conditions = [];
        if (state) conditions.push(`phy_state = '${escapeSoQLString(state.toUpperCase())}'`);
        if (carrierOperation) conditions.push(`carrier_operation = '${escapeSoQLString(carrierOperation.toUpperCase())}'`);
        if (hazmat === 'true') conditions.push(`hm_ind = 'Y'`);

        const statusFilter = (status || 'active').toLowerCase();
        if (statusFilter === 'active') conditions.push(`status_code = 'A'`);
        else if (statusFilter === 'inactive') conditions.push(`status_code = 'I'`);
        // statusFilter === 'all' -> no condition added, leaves both

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
        if (mcs150After) conditions.push(`mcs150_date >= '${escapeSoQLString(mcs150After)}T00:00:00'`);
        if (mcs150Before) conditions.push(`mcs150_date <= '${escapeSoQLString(mcs150Before)}T23:59:59'`);

        const sortMode = (sortBy || 'recent').toLowerCase();
        const orderClause = sortMode === 'none' ? '' : `mcs150_date ${sortMode === 'oldest' ? 'ASC' : 'DESC'}`;
        // When sorting by recency, exclude carriers with no mcs150_date at all -
        // those are often decades-old registrations that never filed, not recent leads.
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
