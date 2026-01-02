const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { Server } = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: ['http://localhost:5173',
        'https://sketchspace-46391.web.app',
        'https://sketchspace-46391.firebaseapp.com',
        'https://sketchspace-server.onrender.com'
    ],
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nmbltxr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:5173",
            'https://sketchspace-46391.web.app',
            'https://sketchspace-46391.firebaseapp.com',
            'https://sketchspace-server.onrender.com'
        ],
        methods: ["GET", "POST"]
    }
});

async function run() {
    try {
        const database = client.db('sketchspaceDB');
        const boardCollection = database.collection('boards');
        const userCollection = database.collection('users');

        // --- AUTH & JWT APIS ---
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '3h' });
            res.cookie('token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
            }).send({ success: true });
        });

        app.post('/logout', async (req, res) => {
            res.clearCookie('token', {
                maxAge: 0,
                secure: process.env.NODE_ENV === "production",
                sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
            }).send({ success: true });
        });

        // --- USER SYNC ---
        app.put('/user/sync', async (req, res) => {
            const user = req.body;
            const filter = { email: user.email };
            const options = { upsert: true };
            const updateDoc = {
                $set: {
                    name: user.name,
                    email: user.email,
                    photoURL: user.photoURL,
                    lastLogin: new Date()
                }
            };
            const result = await userCollection.updateOne(filter, updateDoc, options);
            res.send(result);
        });

        // --- BOARD APIS (Modified for Ownership/Privacy) ---

        // Fetch only boards belonging to or shared with the specific user
        app.get('/allBoards/:email', async (req, res) => {
            const email = req.params.email;
            const query = {
                $or: [
                    { owner: email },
                    { collaborators: { $in: [email] } }
                ]
            };
            const cursor = boardCollection.find(query).project({ elements: 0 });
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get('/board/:roomId', async (req, res) => {
            const id = req.params.roomId;
            const result = await boardCollection.findOne({ roomId: id });
            res.send(result);
        });

        // Save board - now handles ownership and collaborator initialization
        app.put('/board/save/:roomId', async (req, res) => {
            const id = req.params.roomId;
            const { name, elements, userEmail } = req.body; // Expect userEmail from frontend

            const filter = { roomId: id };
            const options = { upsert: true };

            const updateDoc = {
                $set: {
                    name: name,
                    elements: elements,
                    lastModified: new Date()
                },
                // Set these ONLY if the document is being created for the first time
                $setOnInsert: {
                    owner: userEmail,
                    collaborators: []
                }
            };
            const result = await boardCollection.updateOne(filter, updateDoc, options);
            res.send(result);
        });

        // NEW: Invite system endpoint
        app.post('/board/invite', async (req, res) => {
            const { roomId, inviteeEmail } = req.body;
            const result = await boardCollection.updateOne(
                { roomId: roomId },
                { $addToSet: { collaborators: inviteeEmail } }
            );
            res.send(result);
        });

        app.delete('/board/delete/:roomId', async (req, res) => {
            const result = await boardCollection.deleteOne({ roomId: req.params.roomId });
            res.send(result);
        });

        // --- GEMINI AI GENERATE ---
        app.post('/generate', async (req, res) => {
            const { prompt } = req.body;
            if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

            try {
                const model = genAI.getGenerativeModel({
                    model: "gemini-2.5-flash", // Use latest for best stability
                    generationConfig: { responseMimeType: "application/json" }
                });

                const systemPrompt = `
            You are an expert Excalidraw JSON architect. 
            Generate a JSON array of elements for: ${prompt}
            
            Strict Rules:
            1. Use ONLY these types: "rectangle", "ellipse", "diamond", "arrow", "text".
            2. Every element MUST have: x, y, width, height, strokeColor, backgroundColor.
            3. "text" elements must have a "text" field and a "fontSize" (default 20).
            4. "arrow" elements must have "points" (an array of [x, y] coordinates starting at [0,0]).
            5. Ensure all coordinates and dimensions are positive numbers.
            6. Return ONLY a valid JSON array.
        `;

                const result = await model.generateContent(systemPrompt);
                const text = result.response.text();

                // Strip any accidental markdown formatting
                const cleanJson = text.replace(/```json|```/g, "").trim();
                const parsed = JSON.parse(cleanJson);

                // Ensure we send back an array
                const elements = Array.isArray(parsed) ? parsed : (parsed.elements || []);

                res.status(200).json({ elements });
            } catch (error) {
                console.error('Gemini error:', error.message);
                res.status(500).json({ error: 'AI Error', details: error.message });
            }
        });

        // chatbot
        app.post('/chatbot/generate', async (req, res) => {
            // Extract the user prompt from the request body
            const { prompt } = req.body;

            // Check if the prompt is provided
            if (!prompt) {
                return res.status(400).json({ error: 'Prompt is required.' });
            }

            try {
                // Get the specified generative model
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

                // Generate content using the model and the user's prompt
                const result = await model.generateContent(prompt);
                const text = result.response.text();

                // Send the generated text back as a JSON response
                res.status(200).json({ text });
            } catch (error) {
                // Log and handle any errors during the AI generation process
                console.error('Error generating text:', error);
                res.status(500).json({ error: 'Failed to generate content.' });
            }
        });

        // --- SOCKET.IO ---
        io.on('connection', (socket) => {
            socket.on('join-room', (roomId) => { socket.join(roomId); });
            socket.on('drawing-update', (data) => {
                socket.to(data.roomId).emit('receive-drawing', data.elements);
            });
            socket.on('mouse-move', (data) => {
                socket.to(data.roomId).volatile.emit('receive-mouse', {
                    pointer: data.pointer,
                    button: data.button,
                    socketId: socket.id,
                    user: data.user
                });
            });
        });

    } catch (error) {
        console.error("Database error:", error);
    }
}
run().catch(console.dir);

app.get('/', (req, res) => { res.send('SketchSpace Server is running'); });

server.listen(port, () => {
    console.log(`SketchSpace Server running on port ${port}`);
});