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
// No Apify, no per-record cost - queries data.transportation.gov directly.
// Dataset: Company Census File (az4n-8mr2). Every field name below verified against
// the live column schema (not guessed from the PDF data dictionary).
// dot_number is the dataset's one true "number" type column - every other numeric-looking
// field is stored as text and requires an explicit ::number cast for range comparisons.
const SOCRATA_BASE_URL = 'https://data.transportation.gov/resource/az4n-8mr2.json';

function escapeSoQLString(val) {
    return String(val).replace(/'/g, "''");
}

// Maps friendly cargoType values to real column names - confirmed against live schema.
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
            // Real federal filters - at least one required
            state,
            carrierOperation,
            hazmat,

            // Identity / lookup
            dotNumber,         // exact match, numeric column, no cast needed
            legalName,         // partial match
            dbaName,           // partial match
            businessOrgDesc,   // "INDIVIDUAL" / "CORPORATION" / "PARTNERSHIP"

            // Status & classification
            status,            // active (default) / inactive / pending / all
            classContains,     // free-text match against classdef
            safetyRating,      // S = Satisfactory, C = Conditional, U = Unsatisfactory
            priorRevoke,       // "true" - only carriers with a prior USDOT revocation

            // Fleet size (summary totals)
            minPowerUnits, maxPowerUnits,
            minTruckUnits, maxTruckUnits,
            excludeBuses,
            minDrivers, maxDrivers,
            minTotalCdl, maxTotalCdl,

            // Owned equipment (granular)
            minOwnTrucks, maxOwnTrucks,
            minOwnTractors, maxOwnTractors,
            minOwnTrailers, maxOwnTrailers,

            // Term-leased equipment
            minTrmTrucks, maxTrmTrucks,
            minTrmTractors, maxTrmTractors,
            minTrmTrailers, maxTrmTrailers,

            // Trip-leased equipment
            minTrpTrucks, maxTrpTrucks,
            minTrpTractors, maxTrpTractors,
            minTrpTrailers, maxTrpTrailers,

            // Cargo - comma-separated list of CARGO_TYPE_MAP keys, OR logic
            cargoType,

            // Location
            city,
            zipPrefix,
            county,            // 3-digit county FIPS code (phy_cnty)

            // Mileage
            minMileage, maxMileage,

            // Dates
            addDateAfter, addDateBefore,     // when first registered (YYYYMMDD text compare)
            mcs150After, mcs150Before,       // last MCS-150 filing date

            sortBy,
            maxResults,
            offset      // for "Show more" pagination - same filters, next batch
        } = req.query;

        if (!state && !carrierOperation && !hazmat) {
            return res.status(400).json({
                error: 'At least one of state, carrierOperation, or hazmat is required.'
            });
        }

        // Validate and build cargo type OR-clause
        let cargoTypeList = [];
        if (cargoType) {
            cargoTypeList = cargoType.split(',').map(s => s.trim());
            const invalid = cargoTypeList.filter(c => !CARGO_TYPE_MAP[c]);
            if (invalid.length > 0) {
                return res.status(400).json({
                    error: `Invalid cargoType value(s): ${invalid.join(', ')}. Valid options: ${Object.keys(CARGO_TYPE_MAP).join(', ')}`
                });
            }
        }

        const targetCount = Math.min(parseInt(maxResults, 10) || 25, 1000); // default page size: 25
        const startOffset = Math.max(parseInt(offset, 10) || 0, 0);
        const conditions = [];

        // Real federal filters
        if (state) conditions.push(`phy_state = '${escapeSoQLString(state.toUpperCase())}'`);
        if (carrierOperation) conditions.push(`carrier_operation = '${escapeSoQLString(carrierOperation.toUpperCase())}'`);
        if (hazmat === 'true') conditions.push(`hm_ind = 'Y'`);

        // Identity / lookup
        if (dotNumber) conditions.push(`dot_number = ${parseInt(dotNumber, 10)}`);
        if (legalName) conditions.push(`upper(legal_name) like upper('%${escapeSoQLString(legalName)}%')`);
        if (dbaName) conditions.push(`upper(dba_name) like upper('%${escapeSoQLString(dbaName)}%')`);
        if (businessOrgDesc) conditions.push(`upper(business_org_desc) like upper('%${escapeSoQLString(businessOrgDesc)}%')`);

        // Status & classification
        const statusFilter = (status || 'active').toLowerCase();
        if (statusFilter === 'active') conditions.push(`status_code = 'A'`);
        else if (statusFilter === 'inactive') conditions.push(`status_code = 'I'`);
        else if (statusFilter === 'pending') conditions.push(`status_code = 'P'`);

        if (classContains) conditions.push(`upper(classdef) like upper('%${escapeSoQLString(classContains)}%')`);
        if (safetyRating) conditions.push(`safety_rating = '${escapeSoQLString(safetyRating.toUpperCase())}'`);
        if (priorRevoke === 'true') conditions.push(`prior_revoke_flag = 'Y'`);

        // Fleet size
        if (minPowerUnits) conditions.push(`power_units::number >= ${parseInt(minPowerUnits, 10)}`);
        if (maxPowerUnits) conditions.push(`power_units::number <= ${parseInt(maxPowerUnits, 10)}`);
        if (minTruckUnits) conditions.push(`truck_units::number >= ${parseInt(minTruckUnits, 10)}`);
        if (maxTruckUnits) conditions.push(`truck_units::number <= ${parseInt(maxTruckUnits, 10)}`);
        if (excludeBuses === 'true') conditions.push(`bus_units::number = 0`);
        if (minDrivers) conditions.push(`total_drivers::number >= ${parseInt(minDrivers, 10)}`);
        if (maxDrivers) conditions.push(`total_drivers::number <= ${parseInt(maxDrivers, 10)}`);
        if (minTotalCdl) conditions.push(`total_cdl::number >= ${parseInt(minTotalCdl, 10)}`);
        if (maxTotalCdl) conditions.push(`total_cdl::number <= ${parseInt(maxTotalCdl, 10)}`);

        // Owned equipment
        if (minOwnTrucks) conditions.push(`owntruck::number >= ${parseInt(minOwnTrucks, 10)}`);
        if (maxOwnTrucks) conditions.push(`owntruck::number <= ${parseInt(maxOwnTrucks, 10)}`);
        if (minOwnTractors) conditions.push(`owntract::number >= ${parseInt(minOwnTractors, 10)}`);
        if (maxOwnTractors) conditions.push(`owntract::number <= ${parseInt(maxOwnTractors, 10)}`);
        if (minOwnTrailers) conditions.push(`owntrail::number >= ${parseInt(minOwnTrailers, 10)}`);
        if (maxOwnTrailers) conditions.push(`owntrail::number <= ${parseInt(maxOwnTrailers, 10)}`);

        // Term-leased equipment
        if (minTrmTrucks) conditions.push(`trmtruck::number >= ${parseInt(minTrmTrucks, 10)}`);
        if (maxTrmTrucks) conditions.push(`trmtruck::number <= ${parseInt(maxTrmTrucks, 10)}`);
        if (minTrmTractors) conditions.push(`trmtract::number >= ${parseInt(minTrmTractors, 10)}`);
        if (maxTrmTractors) conditions.push(`trmtract::number <= ${parseInt(maxTrmTractors, 10)}`);
        if (minTrmTrailers) conditions.push(`trmtrail::number >= ${parseInt(minTrmTrailers, 10)}`);
        if (maxTrmTrailers) conditions.push(`trmtrail::number <= ${parseInt(maxTrmTrailers, 10)}`);

        // Trip-leased equipment
        if (minTrpTrucks) conditions.push(`trptruck::number >= ${parseInt(minTrpTrucks, 10)}`);
        if (maxTrpTrucks) conditions.push(`trptruck::number <= ${parseInt(maxTrpTrucks, 10)}`);
        if (minTrpTractors) conditions.push(`trptract::number >= ${parseInt(minTrpTractors, 10)}`);
        if (maxTrpTractors) conditions.push(`trptract::number <= ${parseInt(maxTrpTractors, 10)}`);
        if (minTrpTrailers) conditions.push(`trptrail::number >= ${parseInt(minTrpTrailers, 10)}`);
        if (maxTrpTrailers) conditions.push(`trptrail::number <= ${parseInt(maxTrpTrailers, 10)}`);

        // Cargo type - OR logic across however many categories were requested
        if (cargoTypeList.length > 0) {
            const cargoConditions = cargoTypeList.map(c => `${CARGO_TYPE_MAP[c]} = 'X'`);
            conditions.push(`(${cargoConditions.join(' OR ')})`);
        }

        // Location
        if (city) conditions.push(`upper(phy_city) like upper('%${escapeSoQLString(city)}%')`);
        if (zipPrefix) conditions.push(`starts_with(phy_zip, '${escapeSoQLString(zipPrefix)}')`);
        if (county) conditions.push(`phy_cnty = '${escapeSoQLString(county)}'`);

        // Mileage
        if (minMileage) conditions.push(`mcs150_mileage::number >= ${parseInt(minMileage, 10)}`);
        if (maxMileage) conditions.push(`mcs150_mileage::number <= ${parseInt(maxMileage, 10)}`);

        // Dates - add_date and mcs150_date are both text, but comparing text to text
        // (not text to number) so no ::number cast is needed for these.
        if (addDateAfter) conditions.push(`add_date >= '${escapeSoQLString(addDateAfter)}'`);
        if (addDateBefore) conditions.push(`add_date <= '${escapeSoQLString(addDateBefore)}'`);
        if (mcs150After) conditions.push(`mcs150_date >= '${escapeSoQLString(mcs150After)}T00:00:00'`);
        if (mcs150Before) conditions.push(`mcs150_date <= '${escapeSoQLString(mcs150Before)}T23:59:59'`);

        const sortMode = (sortBy || 'recent').toLowerCase();
        const orderClause = sortMode === 'none' ? '' : `mcs150_date ${sortMode === 'oldest' ? 'ASC' : 'DESC'}`;
        if (sortMode !== 'none') conditions.push(`mcs150_date IS NOT NULL`);

        const params = new URLSearchParams();
        params.set('$where', conditions.join(' AND '));
        params.set('$limit', targetCount.toString());
        params.set('$offset', startOffset.toString());
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
            offset: startOffset,
            pageSize: targetCount,
            hasMore: items.length === targetCount, // if a full page came back, there may be more
            requestedFilters: req.query,
            results: items
        });

    } catch (error) {
        console.error('Census Search Error:', error.message);
        res.status(500).json({ error: 'Failed to query the FMCSA census database.' });
    }
});



// ---------- NEW: granular enrichment for ONE company - crash history + inspected vehicles ----------
// Called on-demand for a single DOT number, not bulk - avoids the N+1 cost problem.
const CRASH_FILE_URL = 'https://data.transportation.gov/resource/aayw-vxb3.json';
const VEHICLE_INSPECTION_URL = 'https://data.transportation.gov/resource/fx4q-ay7w.json';
const INSPECTIONS_PER_UNIT_URL = 'https://data.transportation.gov/resource/wt8s-2hbx.json';
const ACTIVE_INSURANCE_URL = 'https://data.transportation.gov/resource/qh9u-swkp.json';
const INSURANCE_HISTORY_URL = 'https://data.transportation.gov/resource/6sqe-dvqs.json';

async function socrataGet(baseUrl, whereClause, limit) {
    const params = new URLSearchParams();
    params.set('$where', whereClause);
    params.set('$limit', limit.toString());
    const url = `${baseUrl}?${params.toString()}`;
    const res = await fetch(url, { headers: { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } });
    if (!res.ok) {
        const errText = await res.text();
        console.error(`Socrata error on ${baseUrl}:`, res.status, errText);
        return null;
    }
    return res.json();
}

// Decodes a single VIN via NHTSA's free vPIC API and returns the useful subset.
// Returns null on any failure so one bad VIN never breaks the whole enrich call.
async function decodeVinBasics(vin) {
    if (!vin || vin.length !== 17) return null;
    try {
        const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${encodeURIComponent(vin)}?format=json`);
        if (!res.ok) return null;
        const data = await res.json();
        const result = data.Results && data.Results[0];
        if (!result || result.ErrorCode === undefined) return null;
        return {
            make: result.Make || null,
            model: result.Model || null,
            modelYear: result.ModelYear || null,
            vehicleType: result.VehicleType || null,
            bodyClass: result.BodyClass || null,
            gvwr: result.GVWR || null
        };
    } catch (err) {
        console.error(`VIN decode failed for ${vin}:`, err.message);
        return null;
    }
}

// Decodes every unique VIN in a list of records in parallel, returns a vin -> decoded map.
async function decodeVinsForRecords(records, vinField) {
    const vins = [...new Set(records.map(r => r[vinField]).filter(Boolean))];
    const decodedPairs = await Promise.all(
        vins.map(async vin => [vin, await decodeVinBasics(vin)])
    );
    return Object.fromEntries(decodedPairs);
}

app.get('/api/enrich', async (req, res) => {
    try {
        const { dotNumber } = req.query;
        if (!dotNumber) {
            return res.status(400).json({ error: 'dotNumber parameter is required.' });
        }
        const dot = escapeSoQLString(dotNumber);

        // 1. Crash File - direct DOT number <-> VIN link, only for crash-involved vehicles
        const crashRecords = await socrataGet(
            CRASH_FILE_URL,
            `dot_number = '${dot}'`,
            50
        );

        // 2. Vehicle Inspection File - find inspection_ids tied to this DOT number
        const inspections = await socrataGet(
            VEHICLE_INSPECTION_URL,
            `dot_number = ${parseInt(dotNumber, 10)}`,
            50
        );

        // 3. Inspections Per Unit - find VINs tied to those inspection_ids
        let inspectedVehicles = [];
        if (inspections && inspections.length > 0) {
            const inspectionIds = inspections.map(i => i.inspection_id).filter(Boolean);
            if (inspectionIds.length > 0) {
                const idList = inspectionIds.map(id => `'${escapeSoQLString(id)}'`).join(',');
                const units = await socrataGet(
                    INSPECTIONS_PER_UNIT_URL,
                    `inspection_id IN (${idList})`,
                    100
                );
                inspectedVehicles = units || [];
            }
        }

        // 4. Decode every VIN found in both sources via NHTSA - free, no key, parallelized
        const crashVinDecoded = await decodeVinsForRecords(crashRecords || [], 'vehicle_identification_number');
        const inspectedVinDecoded = await decodeVinsForRecords(inspectedVehicles, 'insp_unit_vehicle_id_number');

        const crashRecordsWithVehicle = (crashRecords || []).map(r => ({
            ...r,
            decodedVehicle: crashVinDecoded[r.vehicle_identification_number] || null
        }));
        const inspectedVehiclesWithDetail = inspectedVehicles.map(v => ({
            ...v,
            decodedVehicle: inspectedVinDecoded[v.insp_unit_vehicle_id_number] || null
        }));

        res.json({
            dotNumber,
            crashRecords: crashRecordsWithVehicle,
            crashRecordCount: crashRecordsWithVehicle.length,
            inspections: inspections || [],
            inspectionCount: inspections ? inspections.length : 0,
            inspectedVehicles: inspectedVehiclesWithDetail,
            inspectedVehicleCount: inspectedVehiclesWithDetail.length
        });

    } catch (error) {
        console.error('Enrich Error:', error.message);
        res.status(500).json({ error: 'Failed to enrich this DOT number.' });
    }
});



// ---------- NEW: resolve a VIN, company name, or DOT number to one or more candidate DOT numbers ----------
// This is step 1 of the public lookup tool - figures out WHICH company before pulling the full report.
app.get('/api/resolve', async (req, res) => {
    try {
        const { vin, name, dotNumber } = req.query;

        if (!vin && !name && !dotNumber) {
            return res.status(400).json({ error: 'Provide one of: vin, name, or dotNumber.' });
        }

        // --- DOT number: always unique, resolve directly ---
        if (dotNumber) {
            const matches = await socrataGet(
                SOCRATA_BASE_URL,
                `dot_number = ${parseInt(dotNumber, 10)}`,
                1
            );
            if (!matches || matches.length === 0) {
                return res.json({ type: 'none', candidates: [] });
            }
            return res.json({
                type: 'single',
                candidates: [{
                    dotNumber: matches[0].dot_number,
                    legalName: matches[0].legal_name,
                    city: matches[0].phy_city,
                    state: matches[0].phy_state
                }]
            });
        }

        // --- Company name: partial match, could be ambiguous ---
        if (name) {
            const matches = await socrataGet(
                SOCRATA_BASE_URL,
                `upper(legal_name) like upper('%${escapeSoQLString(name)}%')`,
                25
            );
            const candidates = (matches || []).map(m => ({
                dotNumber: m.dot_number,
                legalName: m.legal_name,
                dbaName: m.dba_name || null,
                city: m.phy_city,
                state: m.phy_state,
                statusCode: m.status_code
            }));
            return res.json({
                type: candidates.length === 1 ? 'single' : candidates.length === 0 ? 'none' : 'multiple',
                candidates
            });
        }

        // --- VIN: check Crash File and the Inspection chain, collect unique DOT numbers ---
        if (vin) {
            const dotNumbersFound = new Map(); // dotNumber -> context info

            const crashMatches = await socrataGet(
                CRASH_FILE_URL,
                `vehicle_identification_number = '${escapeSoQLString(vin)}'`,
                10
            );
            (crashMatches || []).forEach(c => {
                if (c.dot_number) {
                    dotNumbersFound.set(c.dot_number, { source: 'crash record', date: c.report_date });
                }
            });

            const unitMatches = await socrataGet(
                INSPECTIONS_PER_UNIT_URL,
                `insp_unit_vehicle_id_number = '${escapeSoQLString(vin)}'`,
                10
            );
            if (unitMatches && unitMatches.length > 0) {
                const inspectionIds = unitMatches.map(u => u.inspection_id).filter(Boolean);
                if (inspectionIds.length > 0) {
                    const idList = inspectionIds.map(id => `'${escapeSoQLString(id)}'`).join(',');
                    const inspectionMatches = await socrataGet(
                        VEHICLE_INSPECTION_URL,
                        `inspection_id IN (${idList})`,
                        50
                    );
                    (inspectionMatches || []).forEach(i => {
                        if (i.dot_number && !dotNumbersFound.has(i.dot_number)) {
                            dotNumbersFound.set(i.dot_number, { source: 'inspection record', date: i.insp_date });
                        }
                    });
                }
            }

            if (dotNumbersFound.size === 0) {
                return res.json({ type: 'none', candidates: [] });
            }

            // Pull a basic company name/location for each DOT number found, for the pick-list
            const candidates = [];
            for (const [dot, context] of dotNumbersFound) {
                const companyMatch = await socrataGet(
                    SOCRATA_BASE_URL,
                    `dot_number = ${parseInt(dot, 10)}`,
                    1
                );
                const company = companyMatch && companyMatch[0];
                candidates.push({
                    dotNumber: dot,
                    legalName: company ? company.legal_name : '(company record not found)',
                    city: company ? company.phy_city : null,
                    state: company ? company.phy_state : null,
                    matchedVia: context.source,
                    matchedDate: context.date
                });
            }

            return res.json({
                type: candidates.length === 1 ? 'single' : 'multiple',
                candidates
            });
        }

    } catch (error) {
        console.error('Resolve Error:', error.message);
        res.status(500).json({ error: 'Failed to resolve this search.' });
    }
});

// ---------- NEW: full report - all 147 census fields + all enrich data, for ONE confirmed DOT number ----------
app.get('/api/full-report', async (req, res) => {
    try {
        const { dotNumber } = req.query;
        if (!dotNumber) {
            return res.status(400).json({ error: 'dotNumber parameter is required.' });
        }

        // 1. Full census record - every field, no trimming
        const censusMatches = await socrataGet(
            SOCRATA_BASE_URL,
            `dot_number = ${parseInt(dotNumber, 10)}`,
            1
        );
        if (!censusMatches || censusMatches.length === 0) {
            return res.status(404).json({ error: 'No company found for this DOT number.' });
        }
        const censusRecord = censusMatches[0];

        // 2. Full enrich data - crash records, inspections, inspected vehicles, all VIN-decoded
        const dot = escapeSoQLString(dotNumber);

        const crashRecords = await socrataGet(CRASH_FILE_URL, `dot_number = '${dot}'`, 50);
        const inspections = await socrataGet(VEHICLE_INSPECTION_URL, `dot_number = ${parseInt(dotNumber, 10)}`, 50);

        let inspectedVehicles = [];
        if (inspections && inspections.length > 0) {
            const inspectionIds = inspections.map(i => i.inspection_id).filter(Boolean);
            if (inspectionIds.length > 0) {
                const idList = inspectionIds.map(id => `'${escapeSoQLString(id)}'`).join(',');
                const units = await socrataGet(INSPECTIONS_PER_UNIT_URL, `inspection_id IN (${idList})`, 100);
                inspectedVehicles = units || [];
            }
        }

        const crashVinDecoded = await decodeVinsForRecords(crashRecords || [], 'vehicle_identification_number');
        const inspectedVinDecoded = await decodeVinsForRecords(inspectedVehicles, 'insp_unit_vehicle_id_number');

        const crashRecordsWithVehicle = (crashRecords || []).map(r => ({
            ...r,
            decodedVehicle: crashVinDecoded[r.vehicle_identification_number] || null
        }));
        const inspectedVehiclesWithDetail = inspectedVehicles.map(v => ({
            ...v,
            decodedVehicle: inspectedVinDecoded[v.insp_unit_vehicle_id_number] || null
        }));

        // Insurance - dot_number in both insurance datasets is zero-padded text
        // (e.g. "00893864"), unlike the plain numeric format in the Census File.
        const paddedDot = String(parseInt(dotNumber, 10)).padStart(8, '0');

        // Currently active or pending policies - empty here is common for inactive
        // carriers, since a lapsed/cancelled policy moves to InsHist instead.
        const activePolicies = await socrataGet(
            ACTIVE_INSURANCE_URL,
            `dot_number = '${paddedDot}'`,
            25
        );

        // Historical/cancelled policies - useful for inactive carriers, and as a red
        // flag for active ones if a policy was cancelled with nothing replacing it.
        const historicalPolicies = await socrataGet(
            INSURANCE_HISTORY_URL,
            `dot_number = '${paddedDot}'`,
            25
        );

        res.json({
            census: censusRecord,
            enrich: {
                crashRecords: crashRecordsWithVehicle,
                crashRecordCount: crashRecordsWithVehicle.length,
                inspections: inspections || [],
                inspectionCount: inspections ? inspections.length : 0,
                inspectedVehicles: inspectedVehiclesWithDetail,
                inspectedVehicleCount: inspectedVehiclesWithDetail.length
            },
            insurance: {
                activePolicies: activePolicies || [],
                activePolicyCount: activePolicies ? activePolicies.length : 0,
                historicalPolicies: historicalPolicies || [],
                historicalPolicyCount: historicalPolicies ? historicalPolicies.length : 0
            }
        });

    } catch (error) {
        console.error('Full Report Error:', error.message);
        res.status(500).json({ error: 'Failed to generate the full report.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
