const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
const { Server } = require('socket.io'); // Added for Real-time
const http = require('http'); // Required to wrap express for Socket.io
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: ['http://localhost:5173'], // Add your production URLs here
    credentials: true
}));
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nmbltxr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// Create HTTP Server for Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST"]
    }
});

async function run() {
    try {
        // Use your specific database name
        const database = client.db('sketchspaceDB'); 
        
        // Define your collections
        const boardCollection = database.collection('boards');
        const userCollection = database.collection('users'); // Ready for auth later

        // --- HTTP APIs ---

        // Fetch all boards for your BoardList dashboard
        app.get('/allBoards', async (req, res) => {
            // We only fetch name and roomId to keep the dashboard fast
            const cursor = boardCollection.find().project({ elements: 0 });
            const result = await cursor.toArray();
            res.send(result);
        });

        // Get a single board by roomId
        app.get('/board/:roomId', async (req, res) => {
            const id = req.params.roomId;
            const query = { roomId: id };
            const result = await boardCollection.findOne(query);
            res.send(result);
        });

        // Save or update board data
        app.put('/board/save/:roomId', async (req, res) => {
            const id = req.params.roomId;
            const boardData = req.body; 
            const filter = { roomId: id };
            const options = { upsert: true };
            
            const updateDoc = {
                $set: {
                    name: boardData.name,
                    elements: boardData.elements,
                    lastModified: new Date()
                }
            };
            
            const result = await boardCollection.updateOne(filter, updateDoc, options);
            res.send(result);
        });

        // Delete board
        app.delete('/board/delete/:roomId', async (req, res) => {
            const id = req.params.roomId;
            const result = await boardCollection.deleteOne({ roomId: id });
            res.send(result);
        });

        // --- Socket.io Collaboration Logic ---
        io.on('connection', (socket) => {
            socket.on('join-room', (roomId) => {
                socket.join(roomId);
            });

            socket.on('drawing-update', (data) => {
                // Broadcast to everyone else in the specific room
                socket.to(data.roomId).emit('receive-drawing', data.elements);
            });
        });

    } catch (error) {
        console.error("Database connection error:", error);
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('SketchSpace Server is running');
});

// IMPORTANT: Use server.listen, not app.listen
server.listen(port, () => {
    console.log(`SketchSpace Server running on port ${port}`);
});