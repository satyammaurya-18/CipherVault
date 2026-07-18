const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./sql');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helper Functions ---

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function generateRoomPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 15; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

function cleanupExpiredRooms() {
    const threshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.cleanupRooms(threshold);
}

// --- Routes ---

app.post('/api/rooms', async (req, res) => {
    try {
        const code = generateRoomCode();
        const password = generateRoomPassword();
        const passwordHash = await bcrypt.hash(password, 10);
        
        db.createRoom(code, passwordHash);
        
        res.json({
            room_code: code,
            room_password: password,
            message: 'Save this password! It will not be shown again.'
        });
    } catch (err) {
        console.error('Create room error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/rooms/join', async (req, res) => {
    try {
        const code = req.body.code.toUpperCase();
        const password = req.body.password;
        
        if (!code || !password) {
            return res.status(400).json({ error: 'Room code and password required' });
        }
        
        const room = db.getRoom(code);
        
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        
        if (!room.is_active) {
            return res.status(410).json({ error: 'Room has expired' });
        }
        
        const passwordValid = await bcrypt.compare(password, room.password_hash);
        
        if (!passwordValid) {
            return res.status(403).json({ error: 'Invalid password' });
        }
        
        db.updateRoomActivity(code);
        
        res.json({ success: true, room_code: room.code });
    } catch (err) {
        console.error('Join room error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- Socket.IO ---

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    socket.on('join-room', (data) => {
        const roomCode = data.roomCode;
        const username = data.username || 'Anonymous';
        
        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.username = username;
        
        db.addUserToRoom(roomCode, username, socket.id);
        
        const users = db.getRoomUsers(roomCode);
        
        socket.to(roomCode).emit('user-joined', { username, users });
        io.to(roomCode).emit('user-count', users.length);
    });
    
    socket.on('send-message', (data) => {
        const roomCode = data.roomCode;
        const username = socket.data.username || 'Anonymous';
        const ciphertext = data.ciphertext;
        const iv = data.iv;
        
        db.saveMessage(roomCode, username, ciphertext, iv);
        db.updateRoomActivity(roomCode);
        
        io.to(roomCode).emit('new-message', {
            sender: username,
            ciphertext,
            iv,
            timestamp: new Date().toISOString()
        });
    });
    
    socket.on('leave-room', (data) => {
        handleDisconnect(socket, data.roomCode);
    });
    
    socket.on('disconnect', () => {
        const roomCode = socket.data.roomCode;
        if (roomCode) {
            handleDisconnect(socket, roomCode);
        }
    });
});

function handleDisconnect(socket, roomCode) {
    const username = socket.data.username;
    
    db.removeUserFromRoom(socket.id);
    socket.leave(roomCode);
    
    const users = db.getRoomUsers(roomCode);
    
    io.to(roomCode).emit('user-left', { username, users });
    io.to(roomCode).emit('user-count', users.length);
    
    if (users.length === 0) {
        setTimeout(() => {
            const remainingUsers = db.getRoomUsers(roomCode);
            if (remainingUsers.length === 0) {
                db.deactivateRoom(roomCode);
                io.to(roomCode).emit('room-destroyed', {
                    message: 'Room destroyed — all users left'
                });
            }
        }, 5000);
    }
}

// --- Start Server ---

async function startServer() {
    await db.initDB();
    
    // Periodic cleanup every 10 minutes
    setInterval(cleanupExpiredRooms, 10 * 60 * 1000);
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`TempChat running on http://localhost:${PORT}`);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});