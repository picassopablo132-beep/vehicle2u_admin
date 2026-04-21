const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const BARK_KEY = "H4pXqrLHwu7ew2CWYjx6Qh";

async function sendBarkNotification(title, body) {
    const url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=Vehicle2U&sound=bell`;
    try {
        await fetch(url);
    } catch (error) {
        // Fallback if fetch is not defined in older Node versions
        console.error("Bark failed");
    }
}

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// ═══════════════════════════════════════════
// DATA STORES
// ═══════════════════════════════════════════

// Active visitors: visitorId -> { socketId, topicId, agent, messages[] }
const visitors = new Map();

// Admin sockets: socketId -> socket
const admins = new Map();

// Generate unique topic ID
function generateTopicId() {
    return 'topic_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Get timestamp
function getTimestamp() {
    return new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

// Broadcast chat list to all admins
function broadcastChatList() {
    const chatList = [];
    visitors.forEach((visitor, visitorId) => {
        chatList.push({
            visitorId: visitorId,
            topicId: visitor.topicId,
            agent: visitor.agent,
            messages: visitor.messages,
            lastMessage: visitor.messages.length > 0
                ? visitor.messages[visitor.messages.length - 1].text || '[Image]'
                : 'New visitor',
            time: visitor.messages.length > 0
                ? visitor.messages[visitor.messages.length - 1].time
                : getTimestamp(),
            unread: visitor.unreadCount || 0,
            isTyping: visitor.isTyping || false,
            connectedAt: visitor.connectedAt
        });
    });

    admins.forEach((socket) => {
        socket.emit('chat_list_update', chatList);
    });
}

// Send message to specific visitor
function sendToVisitor(visitorId, event, data) {
    const visitor = visitors.get(visitorId);
    if (visitor && visitor.socketId) {
        io.to(visitor.socketId).emit(event, data);
    }
}

// ═══════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        server: 'Vehicle2U Chat Server',
        activeVisitors: visitors.size,
        activeAdmins: admins.size,
        uptime: process.uptime()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// ═══════════════════════════════════════════
// SOCKET.IO CONNECTION HANDLER
// ═══════════════════════════════════════════

io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);

    // ─── ADMIN REGISTRATION ───
    socket.on('admin_register', (data) => {
        console.log(`👑 Admin registered: ${socket.id}`, data?.name || 'Unknown');
        admins.set(socket.id, socket);
        socket.isAdmin = true;
        socket.adminName = data?.name || 'Admin';

        // Send current chat list to newly connected admin
        broadcastChatList();
    });

    // ─── VISITOR REGISTRATION ───
    socket.on('register', (data) => {
        const visitorId = data.odvisUserId;
        console.log(`👤 Visitor registered: ${visitorId}`);

        // Check if this visitor already exists (reconnection)
        const existingVisitor = visitors.get(visitorId);

        if (existingVisitor) {
            // If visitor intentionally left before, do NOT reconnect them silently
            // Only reconnect if it was an accidental disconnect
            if (existingVisitor.hasLeft) {
                console.log(`🚫 Visitor ${visitorId} had left — treating as new session`);
                // Fall through to create new visitor entry below
                visitors.delete(visitorId);
            } else {
                // Accidental disconnect — reconnect them
                existingVisitor.socketId = socket.id;
                socket.visitorId = visitorId;

                if (existingVisitor.agent) {
                    socket.emit('agent_assigned', existingVisitor.agent);
                }

                console.log(`🔄 Visitor reconnected: ${visitorId}`);
                broadcastChatList();
                return;
            }
        }

        // New visitor
        const topicId = generateTopicId();

        visitors.set(visitorId, {
            socketId: socket.id,
            topicId: topicId,
            agent: null,
            messages: [],
            unreadCount: 0,
            isTyping: false,
            hasLeft: false,
            connectedAt: Date.now()
        });

        socket.visitorId = visitorId;
        socket.emit('topic_created', topicId);

        broadcastChatList();
    });

    // ─── VISITOR SENDS MESSAGE ───
    socket.on('user_message', (text) => {
        const visitorId = socket.visitorId;
        if (!visitorId) return;

        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        const message = {
            id: Date.now(),
            text: text,
            isAgent: false,
            time: getTimestamp(),
            type: 'text'
        };

        visitor.messages.push(message);
        sendBarkNotification(`Mensaje de ${socket.visitorId.slice(-4)}`, text);
        visitor.unreadCount = (visitor.unreadCount || 0) + 1;
        visitor.isTyping = false;

        console.log(`💬 Visitor ${visitorId}: ${text}`);

        // Notify all admins
        admins.forEach((adminSocket) => {
            adminSocket.emit('visitor_message', {
                visitorId: visitorId,
                message: message
            });
        });

        broadcastChatList();
    });

    // ─── VISITOR SENDS IMAGE ───
    socket.on('user_image', (data) => {
        const visitorId = socket.visitorId;
        if (!visitorId) return;

        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        const message = {
            id: Date.now(),
            text: data.text || '',
            isAgent: false,
            time: getTimestamp(),
            type: 'image',
            imageUrl: data.base64
        };

        visitor.messages.push(message);
        sendBarkNotification(`Imagen de ${socket.visitorId.slice(-4)}`, "📷 Ha enviado una foto");
        visitor.unreadCount = (visitor.unreadCount || 0) + 1;
        visitor.isTyping = false;

        console.log(`📷 Visitor ${visitorId} sent image`);

        admins.forEach((adminSocket) => {
            adminSocket.emit('visitor_message', {
                visitorId: visitorId,
                message: message
            });
        });

        broadcastChatList();
    });

    // ─── VISITOR TYPING ───
    socket.on('visitor_typing', (isTyping) => {
        const visitorId = socket.visitorId;
        if (!visitorId) return;

        const visitor = visitors.get(visitorId);
        if (visitor) {
            visitor.isTyping = isTyping;
        }

        admins.forEach((adminSocket) => {
            adminSocket.emit('visitor_typing_update', {
                visitorId: visitorId,
                isTyping: isTyping
            });
        });
    });

    // ─── ADMIN SENDS MESSAGE ───
    socket.on('admin_message', (data) => {
        const { visitorId, text } = data;
        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        const agent = visitor.agent;
        const message = {
            id: Date.now(),
            text: text,
            isAgent: true,
            time: getTimestamp(),
            type: 'text',
            agentName: agent?.name || 'Agent'
        };

        visitor.messages.push(message);

        console.log(`📤 Admin -> Visitor ${visitorId}: ${text}`);

        // Send to visitor
        sendToVisitor(visitorId, 'admin_message', {
            text: text,
            avatar: agent?.avatar || 'https://via.placeholder.com/150'
        });

        // Notify other admins about the new message
        admins.forEach((adminSocket) => {
            adminSocket.emit('admin_message_sent', {
                visitorId: visitorId,
                message: message
            });
        });

        broadcastChatList();
    });

    // ─── ADMIN SENDS IMAGE ───
    socket.on('admin_image', (data) => {
        const { visitorId, base64, text } = data;
        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        const agent = visitor.agent;
        const message = {
            id: Date.now(),
            text: text || '',
            isAgent: true,
            time: getTimestamp(),
            type: 'image',
            imageUrl: base64,
            agentName: agent?.name || 'Agent'
        };

        visitor.messages.push(message);

        sendToVisitor(visitorId, 'admin_image', {
            text: text || '',
            avatar: agent?.avatar || 'https://via.placeholder.com/150',
            url: base64
        });

        admins.forEach((adminSocket) => {
            adminSocket.emit('admin_message_sent', {
                visitorId: visitorId,
                message: message
            });
        });

        broadcastChatList();
    });

    // ─── ADMIN TYPING ───
    socket.on('admin_typing', (data) => {
        const { visitorId, isTyping } = data;
        sendToVisitor(visitorId, 'admin_typing', isTyping);
    });

    // ─── ADMIN MARKS CHAT AS READ ───
    socket.on('mark_read', (visitorId) => {
        const visitor = visitors.get(visitorId);
        if (visitor) {
            visitor.unreadCount = 0;
            broadcastChatList();
        }
    });

    // ─── AGENT TRANSFER / ASSIGNMENT ───
    socket.on('transfer_agent', (data) => {
        const { visitorId, agent } = data;
        // agent = { name, department, gender, avatar }
        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        console.log(`🔄 Agent transfer for ${visitorId}: ${agent.name} (${agent.department})`);

        // Step 1: Tell the visitor "waiting for agent"
        sendToVisitor(visitorId, 'waiting_for_agent', {});

        // Step 2: After a delay, assign the new agent
        setTimeout(() => {
            visitor.agent = agent;

            // Tell the visitor about the new agent
            sendToVisitor(visitorId, 'agent_assigned', agent);

            // Add a system message
            const systemMsg = {
                id: Date.now(),
                text: `${agent.name} (${agent.department}) se ha unido al chat.`,
                isAgent: true,
                time: getTimestamp(),
                type: 'system'
            };
            visitor.messages.push(systemMsg);

            // Notify admins
            admins.forEach((adminSocket) => {
                adminSocket.emit('agent_transferred', {
                    visitorId: visitorId,
                    agent: agent
                });
            });

            broadcastChatList();
        }, 3000); // 3 second delay for the "connecting" animation
    });

    // ─── ADMIN SENDS DOCUMENT WIDGET ───
    socket.on('send_document_widget', (data) => {
        const { visitorId } = data;
        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        sendToVisitor(visitorId, 'custom_widget', 'document');

        const message = {
            id: Date.now(),
            text: '[Documento enviado]',
            isAgent: true,
            time: getTimestamp(),
            type: 'widget_document'
        };
        visitor.messages.push(message);

        admins.forEach((adminSocket) => {
            adminSocket.emit('admin_message_sent', {
                visitorId: visitorId,
                message: message
            });
        });

        broadcastChatList();
    });

    // ─── ADMIN SENDS LINK WIDGET ───
    socket.on('send_link_widget', (data) => {
        const { visitorId, url } = data;
        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        sendToVisitor(visitorId, 'link_widget', { url: url });

        const message = {
            id: Date.now(),
            text: `[Enlace: ${url}]`,
            isAgent: true,
            time: getTimestamp(),
            type: 'widget_link'
        };
        visitor.messages.push(message);

        admins.forEach((adminSocket) => {
            adminSocket.emit('admin_message_sent', {
                visitorId: visitorId,
                message: message
            });
        });

        broadcastChatList();
    });

    // ─── ADMIN ENDS CHAT ───
    socket.on('end_chat', (visitorId) => {
        const visitor = visitors.get(visitorId);
        if (!visitor) return;

        console.log(`🔚 Chat ended for visitor: ${visitorId}`);

        // Notify the visitor
        sendToVisitor(visitorId, 'chat_ended', {});

        // Remove from active visitors
        visitors.delete(visitorId);

        broadcastChatList();
    });

    // ─── PING/PONG KEEPALIVE ───
    socket.on('ping_server', () => {
        socket.emit('pong_server');
    });

    // ─── DISCONNECT ───
    socket.on('disconnect', (reason) => {
        console.log(`❌ Disconnected: ${socket.id} (${reason})`);

        // If admin disconnected
        if (socket.isAdmin) {
            admins.delete(socket.id);
            console.log(`👑 Admin disconnected. Active admins: ${admins.size}`);
        }

        // If visitor disconnected - keep their data for reconnection
        if (socket.visitorId) {
            const visitor = visitors.get(socket.visitorId);
            if (visitor) {
                visitor.socketId = null;
                console.log(`👤 Visitor ${socket.visitorId} disconnected (data preserved)`);

                // Auto-cleanup after 30 minutes of inactivity
                setTimeout(() => {
                    const v = visitors.get(socket.visitorId);
                    if (v && v.socketId === null) {
                        visitors.delete(socket.visitorId);
                        broadcastChatList();
                        console.log(`🗑️ Visitor ${socket.visitorId} cleaned up (inactive)`);
                    }
                }, 30 * 60 * 1000);
            }

            broadcastChatList();
        }
    });
});

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`\n🚀 Vehicle2U Chat Server running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Status: http://localhost:${PORT}/\n`);
});
