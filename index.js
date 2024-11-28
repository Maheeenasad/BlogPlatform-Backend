const express = require('express');
const sql = require('mssql');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config(); // Load environment variables
const { DefaultAzureCredential } = require('@azure/identity');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const { BlobServiceClient } = require('@azure/storage-blob');


const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerName = 'blogmedia'; // Replace with your container name
const containerClient = blobServiceClient.getContainerClient(containerName);

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() }); // Use memory storage for quick processing


// Azure Speech Service configuration
const speechConfig = sdk.SpeechConfig.fromSubscription('EOAIKDj38SscECmUr6A3OuD0y6tAm1wdO2MmfGCO1Fjg4uUyOgxtJQQJ99AKACF24PCXJ3w3AAAYACOGYAAi', 'uaenorth'); // Replace YOUR_KEY and YOUR_REGION with your Azure Speech keys and region

// Initialize Express app
const app = express();

// Middleware setup
app.use(express.json()); // A lighter middleware for JSON parsing
app.use(cors());

// Environment variables for Text Analytics API
const textAnalyticsEndpoint = process.env.TEXT_ANALYTICS_ENDPOINT;
const textAnalyticsKey = process.env.TEXT_ANALYTICS_KEY;

// Azure SQL Database configuration
const dbConfig = {
    server: 'blogserver2024.database.windows.net', // Replace with your SQL server name
    database: 'BlogDB', // Replace with your database name
    options: {
        encrypt: true, // Use encryption
        enableArithAbort: true
    },
    authentication: {
        type: 'azure-active-directory-access-token',
        options: {
            token: null // Token will be dynamically generated
        }
    }
};

let pool; // Global database connection pool

// Function to get Azure Active Directory token and connect to SQL
async function getAzureTokenAndConnect() {
    try {
        const credential = new DefaultAzureCredential();
        const accessToken = await credential.getToken('https://database.windows.net/');
        dbConfig.authentication.options.token = accessToken.token;

        pool = await sql.connect(dbConfig);
        console.log('Connected to Azure SQL Database using a refreshed token!');
        return pool;
    } catch (error) {
        console.error('Error connecting to Azure SQL Database:', error.message);
        throw error;
    }
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const blobName = req.file.originalname; // Use the original file name
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        // Upload file buffer to Blob Storage
        await blockBlobClient.uploadData(req.file.buffer, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype },
        });

        const fileUrl = blockBlobClient.url; // URL of the uploaded file
        res.status(200).json({ message: 'File uploaded successfully!', url: fileUrl });
    } catch (error) {
        console.error('Error uploading file:', error.message);
        res.status(500).json({ error: 'Failed to upload file', details: error.message });
    }
});


app.get('/api/files/:filename', async (req, res) => {
    try {
        const blobName = req.params.filename;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        // Generate a temporary URL to access the file
        const sasUrl = blockBlobClient.url; // Use SAS (Shared Access Signature) for secure access if needed
        res.redirect(sasUrl);
    } catch (error) {
        console.error('Error fetching file:', error.message);
        res.status(500).json({ error: 'Failed to fetch file', details: error.message });
    }
});


// Endpoint to fetch a single blog by ID
app.get('/api/blogs/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getAzureTokenAndConnect(); // Connect to the database
        const result = await pool
            .request()
            .input('Id', sql.Int, id) // Use parameterized query
            .query('SELECT * FROM Blogs WHERE Id = @Id'); // Fetch blog by ID
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Blog not found' });
        }
        res.status(200).json(result.recordset[0]); // Send the first record as JSON
    } catch (error) {
        console.error('Error fetching blog by ID:', error.message);
        res.status(500).json({ error: 'Failed to fetch blog', details: error.message });
    }
});


// Test database connection endpoint
app.get('/api/test-connection', async (req, res) => {
    try {
        const pool = await getAzureTokenAndConnect();
        res.status(200).json({ message: 'Database connection successful!' });
    } catch (error) {
        console.error('Database connection error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Test summarization endpoint
app.post('/api/test-summarization', async (req, res) => {
    const { content } = req.body;
    try {
        const response = await axios.post(
            `${textAnalyticsEndpoint}/text/analytics/v3.1-preview.1/extractiveSummarization`,
            {
                documents: [{ id: '1', language: 'en', text: content }]
            },
            {
                headers: { 'Ocp-Apim-Subscription-Key': textAnalyticsKey }
            }
        );
        const summary = response.data.documents[0]?.summary || 'No summary generated';
        res.status(200).json({ summary });
    } catch (error) {
        console.error('Error calling Text Analytics API:', error.message);
        res.status(500).json({ error: 'Text Analytics API failed', details: error.message });
    }
});

// Main endpoint to add a blog
app.post('/api/blogs', upload.single('file'), async (req, res) => {
    const { title, content } = req.body; // Extract text fields from request body
    let mediaUrl = null;

    try {
        // Handle file upload if a file is provided
        if (req.file) {
            const blobName = req.file.originalname;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            await blockBlobClient.uploadData(req.file.buffer, {
                blobHTTPHeaders: { blobContentType: req.file.mimetype },
            });

            mediaUrl = blockBlobClient.url; // Get the uploaded file's URL
        }

        // Generate a summary for the content
        const keyPhrasesResponse = await axios.post(
            `${textAnalyticsEndpoint}/text/analytics/v3.1/keyPhrases`,
            {
                documents: [{ id: '1', language: 'en', text: content }],
            },
            {
                headers: { 'Ocp-Apim-Subscription-Key': textAnalyticsKey },
            }
        );
        const keyPhrases = keyPhrasesResponse.data.documents[0]?.keyPhrases || [];
        const summary = keyPhrases.length > 0 ? keyPhrases.join(', ') : 'No summary available';

        // Insert the blog into the database
        const pool = await getAzureTokenAndConnect();
        await pool.request()
            .query`INSERT INTO Blogs (Title, Content, Summary, MediaUrl) VALUES (${title}, ${content}, ${summary}, ${mediaUrl})`;

        res.status(200).json({ message: 'Blog added successfully!', summary });
    } catch (error) {
        console.error('Error adding blog:', error.message);
        res.status(500).json({ error: 'Failed to add blog', details: error.message });
    }
});



// Endpoint to fetch all blogs
app.get('/api/blogs', async (req, res) => {
    try {
        console.log('GET request received for /api/blogs');
        const pool = await getAzureTokenAndConnect(); // Connect to the database
        const result = await pool.request().query('SELECT * FROM Blogs'); // Fetch all rows
        console.log('Blogs fetched:', result.recordset);
        res.status(200).json(result.recordset); // Send rows as JSON
    } catch (error) {
        console.error('Error fetching blogs:', error.message);
        res.status(500).json({ error: 'Failed to fetch blogs', details: error.message });
    }
});

// Endpoint to update a blog by ID
app.put('/api/blogs/:id', upload.single('file'), async (req, res) => {
    const { id } = req.params;
    const { title, content } = req.body; // Extract title and content
    let mediaUrl = null;

    try {
        const pool = await getAzureTokenAndConnect();

        // Fetch the existing media URL
        const result = await pool.request()
            .input('Id', sql.Int, id)
            .query('SELECT MediaUrl FROM Blogs WHERE Id = @Id');
        const oldMediaUrl = result.recordset[0]?.MediaUrl;

        // If a new file is uploaded
        if (req.file) {
            const blobName = req.file.originalname;
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            // Upload the new file
            await blockBlobClient.uploadData(req.file.buffer, {
                blobHTTPHeaders: { blobContentType: req.file.mimetype },
            });

            mediaUrl = blockBlobClient.url;

            // Delete the old media file from Azure Blob Storage, if it exists
            if (oldMediaUrl) {
                const oldBlobName = oldMediaUrl.split('/').pop(); // Extract blob name
                const oldBlockBlobClient = containerClient.getBlockBlobClient(oldBlobName);

                try {
                    await oldBlockBlobClient.delete();
                } catch (deleteError) {
                    console.error('Failed to delete old media:', deleteError.message);
                }
            }
        } else {
            // Retain the old media URL if no new file is uploaded
            mediaUrl = oldMediaUrl;
        }

        // Update the blog in the database
        await pool.request()
            .input('Id', sql.Int, id)
            .input('Title', sql.NVarChar, title)
            .input('Content', sql.NVarChar, content)
            .input('MediaUrl', sql.NVarChar, mediaUrl)
            .query(`
                UPDATE Blogs
                SET Title = @Title, Content = @Content, MediaUrl = @MediaUrl
                WHERE Id = @Id
            `);

        res.status(200).json({ message: 'Blog updated successfully!' });
    } catch (error) {
        console.error('Error updating blog:', error.message);
        res.status(500).json({ error: 'Failed to update blog', details: error.message });
    }
});

app.post('/api/chatbot', async (req, res) => {
    const { question } = req.body;

    try {
        const response = await axios.post(
            'https://blogopenai.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2024-08-01-preview',
            {
                messages: [
                    {
                        role: 'system',
                        content: `
                            You are a blog writing assistant. Format the response in Markdown. Use:
                            - Headings with '#' (e.g., # for main headings, ## for subheadings).
                            - Separate paragraphs with double line breaks.
                            - Ensure the response is detailed, complete, and well-structured.
                            If the user asks for a blog, write a full-length blog covering the topic in-depth.
                        `,
                    },
                    { role: 'user', content: question },
                ],
                max_tokens: 1000, // Increased token limit for a detailed response
                temperature: 0.7,
            },
            {
                headers: {
                    'api-key':  process.env.OPENAI_API_KEY,
                    'Content-Type': 'application/json',
                },
            }
        );

        const answer = response.data.choices[0].message.content.trim();
        res.status(200).json({ answer });
    } catch (error) {
        console.error('Error interacting with chatbot:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to interact with chatbot', details: error.response?.data || error.message });
    }
});

  



// Endpoint to delete a blog by ID
app.delete('/api/blogs/:id', async (req, res) => {
    const { id } = req.params; // Extract blog ID from URL

    try {
        console.log(`DELETE request received for /api/blogs/${id}`);

        const pool = await getAzureTokenAndConnect(); // Connect to the database
        const result = await pool.request()
            .query`DELETE FROM Blogs WHERE Id = ${id}`; // Delete the blog with the given ID

        if (result.rowsAffected[0] === 0) {
            // If no rows were affected, the blog was not found
            res.status(404).json({ error: `Blog with ID ${id} not found.` });
        } else {
            // If deletion was successful
            res.status(200).json({ message: 'Blog deleted successfully!' });
        }
    } catch (error) {
        console.error('Error deleting blog:', error.message);
        res.status(500).json({ error: 'Failed to delete blog', details: error.message });
    }
});

// TTS endpoint
app.post('/api/synthesize', async (req, res) => {
    const { text } = req.body; // Accept text from the request body

    try {
        // Create Speech Synthesizer
        const audioConfig = sdk.AudioConfig.fromAudioFileOutput('./output.wav'); // Specify file to store audio
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

        synthesizer.speakTextAsync(
            text,
            (result) => {
                synthesizer.close();

                if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                    console.log('Speech synthesis succeeded.');
                    res.sendFile(`${__dirname}/output.wav`); // Send audio file as a response
                } else {
                    console.error('Speech synthesis failed:', result.errorDetails);
                    res.status(500).send('Speech synthesis failed.');
                }
            },
            (error) => {
                console.error(error);
                synthesizer.close();
                res.status(500).send('An error occurred.');
            }
        );
    } catch (error) {
        console.error('Error synthesizing speech:', error);
        res.status(500).send('Failed to synthesize speech.');
    }
});

// Start the server
app.listen(3000, () => {
    console.log('Server running on port 3000');
});
