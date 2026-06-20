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

// ---------- EXISTING: single-carrier lookup by name/DOT/MC ----------
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

// ---------- NEW: combinable filter search across the full census ----------
// Real server-side filters: state, carrierOperation, hazmat
// Refine-only filters (applied after the real data comes back): minPowerUnits, maxPowerUnits, cargoType
app.get('/api/census-search', async (req, res) => {
    try {
        const {
            state,            // e.g. "GA" - real federal filter
            carrierOperation, // "A" = Authorized for Hire, "B" = Exempt, "C" = Private
            hazmat,           // "true" / "false" - real federal filter
            minPowerUnits,    // refine-only, applied after fetch
            maxPowerUnits,    // refine-only, applied after fetch
            cargoType,        // refine-only, applied after fetch
            maxResults
        } = req.query;

        // Require at least one real filter so we never accidentally pull the whole 4.4M file
        if (!state && !carrierOperation && !hazmat) {
            return res.status(400).json({
                error: 'At least one of state, carrierOperation, or hazmat is required.'
            });
        }

        const cappedMax = Math.min(parseInt(maxResults, 10) || 500, 1000); // hard cost ceiling

        const actorInput = {
            maxResults: cappedMax
        };
        if (state) actorInput.state = state.toUpperCase();
        if (carrierOperation) actorInput.carrierOperation = carrierOperation.toUpperCase();
        if (hazmat === 'true') actorInput.hazmat = true;

        const run = await client.actor("compute-edge/fmcsa-motor-carriers-scraper").call(actorInput);
        let { items } = await client.dataset(run.defaultDatasetId).listItems();

        // Refine-only filters applied to the real result set
        if (minPowerUnits) {
            const min = parseInt(minPowerUnits, 10);
            items = items.filter(c => parseInt(c.powerUnits || c.totalPowerUnits || 0, 10) >= min);
        }
        if (maxPowerUnits) {
            const max = parseInt(maxPowerUnits, 10);
            items = items.filter(c => parseInt(c.powerUnits || c.totalPowerUnits || 0, 10) <= max);
        }
        if (cargoType) {
            const needle = cargoType.toLowerCase();
            items = items.filter(c => {
                const cargo = Array.isArray(c.cargoCarried) ? c.cargoCarried.join(' ') : (c.cargoCarried || '');
                return cargo.toLowerCase().includes(needle);
            });
        }

        res.json({
            count: items.length,
            requestedFilters: { state, carrierOperation, hazmat, minPowerUnits, maxPowerUnits, cargoType },
            results: items
        });

    } catch (error) {
        console.error('Census Search Proxy Error:', error.message);
        res.status(500).json({ error: 'Failed to query the FMCSA census database.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
