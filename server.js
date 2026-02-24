const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
          origin: '*',
          methods: ['GET', 'POST']
    }
});

const SESSION_DURATION = 3 * 60 * 1000; // 3 minutes in ms

let waitingSocket = null;
const activeSessions = new Map(); // socketId -> { partner, timer }

app.get('/', (req, res) => {
    res.send('CrossPath server is running');
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

        socket.on('join_queue', () => {
              console.log('User joined queue:', socket.id);

                      if (waitingSocket && waitingSocket.id !== socket.id && waitingSocket.connected) {
                              const partner = waitingSocket;
                              waitingSocket = null;

                // Notify both users they are matched
                socket.emit('matched');
                              partner.emit('matched');

                // Start session timer
                const timer = setTimeout(() => {
                          socket.emit('session_ended');
                          partner.emit('session_ended');
                          cleanupSession(socket.id);
                          cleanupSession(partner.id);
                }, SESSION_DURATION);

                activeSessions.set(socket.id, { partner: partner, timer });
                              activeSessions.set(partner.id, { partner: socket, timer });
                      } else {
                              waitingSocket = socket;
                      }
        });

        socket.on('leave_queue', () => {
              if (waitingSocket && waitingSocket.id === socket.id) {
                      waitingSocket = null;
                      console.log('User left queue:', socket.id);
              }
        });

        socket.on('send_message', (message) => {
              const session = activeSessions.get(socket.id);
              if (session && session.partner && session.partner.connected) {
                      session.partner.emit('receive_message', message);
              }
        });

        socket.on('disconnect', () => {
              console.log('User disconnected:', socket.id);

                      if (waitingSocket && waitingSocket.id === socket.id) {
                              waitingSocket = null;
                      }

                      const session = activeSessions.get(socket.id);
              if (session) {
                      clearTimeout(session.timer);
                      if (session.partner && session.partner.connected) {
                                session.partner.emit('session_ended');
                                cleanupSession(session.partner.id);
                      }
                      activeSessions.delete(socket.id);
              }
        });
});

function cleanupSession(socketId) {
    const session = activeSessions.get(socketId);
    if (session) {
          clearTimeout(session.timer);
          activeSessions.delete(socketId);
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`CrossPath server running on port ${PORT}`);
});
