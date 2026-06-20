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
            enrichWithWebSearch: true // Enabled to pull websites, social media links, and digital data if available
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        res.json(items);

    } catch (error) {
        console.error('Apify Proxy Error:', error.message);
        res.status(500).json({ error: 'Failed to query the cloud trucking database.' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
