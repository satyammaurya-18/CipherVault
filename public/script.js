
let hasLeftRoom = false;

// Web Crypto API Encryption

async function deriveKeyFromPassword(password) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode('TempChat2024'),
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        {
            name: 'AES-GCM',
            length: 256
        },
        false,
        ['encrypt', 'decrypt']
    );
}



async function encryptMessage(plaintext, password) {
    const key = await deriveKeyFromPassword(password);
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(plaintext)
    );

    return {
        ciphertext: arrayBufferToBase64(encrypted),
        iv: arrayBufferToBase64(iv)
    };
}

async function decryptMessage(ciphertext, iv, password) {
    const key = await deriveKeyFromPassword(password);
    const decoder = new TextDecoder();

    const encryptedBytes = base64ToArrayBuffer(ciphertext);
    const ivBytes = base64ToArrayBuffer(iv);

    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: ivBytes },
            key,
            encryptedBytes
        );
        return decoder.decode(decrypted);
    } catch (e) {
        return '[Decryption failed — wrong password?]';
    }
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Socket.IO Connection
const socket = io();

// -- Join Room --
function joinRoom() {
    const code = document.getElementById('room-code').value.toUpperCase();
    const password = document.getElementById('room-password').value;
    const username = document.getElementById('username').value || 'Anonymous';

    if (!code || !password) {
        alert('Please enter room code and password');
        return;
    }

    fetch('/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password })
    })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                // Store in sessionStorage (clears on tab close)
                sessionStorage.setItem('roomCode', code);
                sessionStorage.setItem('roomPassword', password);
                sessionStorage.setItem('username', username);
                window.location.href = '/chat.html';
            } else {
                alert(data.error || 'Failed to join room');
            }
        })
        .catch(err => alert('Connection error'));
}

// -- Create Room --
function createRoom() {
    fetch('/api/rooms', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            document.getElementById('room-credentials').style.display = 'block';
            document.getElementById('new-code').textContent = data.room_code;
            document.getElementById('new-password').textContent = data.room_password;
        });
}

function copyCredentials() {
    const code = document.getElementById('new-code').textContent;
    const password = document.getElementById('new-password').textContent;
    navigator.clipboard.writeText(`Room: ${code}\nPassword: ${password}`);
    alert('Copied!');
}

// -- Chat Page Logic --
if (window.location.pathname === '/chat.html') {
    const roomCode = sessionStorage.getItem('roomCode');
    const roomPassword = sessionStorage.getItem('roomPassword');
    const username = sessionStorage.getItem('username');

    document.getElementById("leave-btn").addEventListener("click", leaveRoom);

    function leaveRoom() {

        if (hasLeftRoom) return;
        hasLeftRoom = true;
    
        socket.emit("leave-room", { roomCode });
    
        sessionStorage.clear();
    
        window.location.href = "/";
    }

    if (!roomCode || !roomPassword) {
        window.location.href = '/';
    }

    document.getElementById('room-display').textContent = roomCode;
    document.getElementById('password-display').textContent = roomPassword;
    document.getElementById('user-display').textContent = username;

    // Join socket room
    socket.emit('join-room', { roomCode, username });

    // Send message
    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    async function sendMessage() {
        const input = document.getElementById('message-input');
        const plaintext = input.value.trim();

        if (!plaintext) return;

        const { ciphertext, iv } = await encryptMessage(plaintext, roomPassword);

        socket.emit('send-message', { roomCode, ciphertext, iv });

        input.value = '';
    }

    // Receive message
    socket.on('new-message', async (data) => {
        const plaintext = await decryptMessage(data.ciphertext, data.iv, roomPassword);

        displayMessage(
            data.sender,
            plaintext,
            data.sender === username
        );
    });

    function displayMessage(sender, text, isOwn) {
        const container = document.getElementById('messages');
        const div = document.createElement('div');
        div.className = `message ${isOwn ? 'own' : 'other'}`;
        div.innerHTML = `
            <strong>${sender}</strong>
            <p>${text}</p>
            <small>${new Date().toLocaleTimeString()}</small>
        `;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    // User joined/left notifications
    socket.on('user-joined', (data) => {
        addSystemMessage(`${data.username} joined the room`);
        updateUserList(data.users);
    });

    socket.on('user-left', (data) => {
        addSystemMessage(`${data.username} left the room`);
        updateUserList(data.users);
    });

    socket.on('room-destroyed', (data) => {
        addSystemMessage(data.message);
        document.getElementById('message-input').disabled = true;
        document.getElementById('send-btn').disabled = true;
    });

    function addSystemMessage(text) {
        const container = document.getElementById('messages');
        const div = document.createElement('div');
        div.className = 'system-message';
        div.textContent = text;
        container.appendChild(div);
    }

    function updateUserList(users) {
        const list = document.getElementById('user-list');
        list.innerHTML = '';
        users.forEach(user => {
            const li = document.createElement('li');
            li.textContent = user.username;
            list.appendChild(li);
        });
    }

    // Handle page close
    window.addEventListener("beforeunload", () => {

        if (!hasLeftRoom) {
            socket.emit("leave-room", { roomCode });
        }
    
    });
}
