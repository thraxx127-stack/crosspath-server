 const express = require('express');                                           
  const http    = require('http');                                              
  const { Server } = require('socket.io');                                      
  const path    = require('path');                                              
                                                                                
  const app    = express();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: false,
    },
    // Allow both transports so mobile/browser fallback works
    transports: ['websocket', 'polling'],
  });

  const PORT       = process.env.PORT || 3001;
  const SESSION_MS = 3 * 60 * 1000; // 3 minutes

  // ── In-memory state
  ───────────────────────────────────────────────────────────
  let queue = [];                 // socket IDs waiting to be matched
  const sessions = new Map();    // roomId → { users, timer, startTime }

  // ── Health check (wakes Render from cold start)
  ───────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', queue: queue.length, sessions: sessions.size });
  });

  // ── Helpers
  ───────────────────────────────────────────────────────────────────
  function createSession(id1, id2) {
    const s1 = io.sockets.sockets.get(id1);
    const s2 = io.sockets.sockets.get(id2);

    if (!s1 || !s2) {
      console.log(`[MATCH] One socket gone during pairing — re-queuing
  survivors`);
      if (s1) { s1.data.status = 'queued'; queue.push(id1); }
      if (s2) { s2.data.status = 'queued'; queue.push(id2); }
      return;
    }

    const roomId    = `room_${Date.now()}_${Math.random().toString(36).slice(2,
  9)}`;
    const startTime = Date.now();

    [s1, s2].forEach(s => {
      s.join(roomId);
      s.data.status = 'in_session';
      s.data.roomId = roomId;
    });

    const timer = setTimeout(() => endSession(roomId, 'timeout'), SESSION_MS);
    sessions.set(roomId, { users: [id1, id2], timer, startTime });

    io.to(roomId).emit('matched', { roomId, startTime, duration: SESSION_MS });

    console.log(`[MATCH] ✓ Paired ${id1} ↔ ${id2} in room ${roomId}`);
    console.log(`[SESSION] Started — ends in 3 min`);
  }

  function endSession(roomId, reason = 'ended') {
    const session = sessions.get(roomId);
    if (!session) return;

    clearTimeout(session.timer);
    io.to(roomId).emit('session_ended', { reason });

    session.users.forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (s) {
        s.leave(roomId);
        s.data.status = 'idle';
        s.data.roomId = null;
      }
    });

    sessions.delete(roomId);
    console.log(`[SESSION] Ended — room ${roomId} (reason: ${reason})`);
  }

  function tryMatch() {
    // Prune any stale/disconnected IDs before attempting a match
    const before = queue.length;
    queue = queue.filter(id => {
      const s = io.sockets.sockets.get(id);
      return s && s.data.status === 'queued';
    });
    if (queue.length !== before) {
      console.log(`[QUEUE] Pruned ${before - queue.length} stale entries`);
    }

    console.log(`[QUEUE] Size after prune: ${queue.length}`);

    if (queue.length >= 2) {
      const [id1, id2] = queue.splice(0, 2);
      console.log(`[MATCH] Two users ready — creating session…`);
      createSession(id1, id2);
    } else {
      console.log(`[QUEUE] Waiting for second user…`);
    }
  }

  // ── Socket.io
  ─────────────────────────────────────────────────────────────────
  io.on('connection', socket => {
    socket.data.status = 'idle';
    socket.data.roomId = null;
    console.log(`[CONNECT] ${socket.id} connected (total:
  ${io.sockets.sockets.size})`);

    // ── join_queue
  ──────────────────────────────────────────────────────────────
    socket.on('join_queue', () => {
      if (socket.data.status !== 'idle') {
        console.log(`[QUEUE] ${socket.id} tried to join but
  status=${socket.data.status} — ignored`);
        return;
      }
      socket.data.status = 'queued';
      queue.push(socket.id);
      console.log(`[QUEUE] ${socket.id} joined (queue size: ${queue.length})`);
      tryMatch();
    });

    // ── leave_session (user clicks Leave Pathway during chat)
  ──────────────────
    socket.on('leave_session', () => {
      const roomId = socket.data.roomId;
      if (roomId && sessions.has(roomId)) {
        console.log(`[SESSION] ${socket.id} left early`);
        endSession(roomId, 'partner_disconnected');
      }
      socket.data.status = 'idle';
    });

    // ── leave_queue
  ─────────────────────────────────────────────────────────────
    socket.on('leave_queue', () => {
      queue = queue.filter(id => id !== socket.id);
      socket.data.status = 'idle';
      console.log(`[QUEUE] ${socket.id} left (queue size: ${queue.length})`);
    });

    // ── send_message
  ────────────────────────────────────────────────────────────
    socket.on('send_message', ({ roomId, message }) => {
      if (!message?.trim()) return;
      if (socket.data.roomId !== roomId) {
        console.log(`[MSG] ${socket.id} sent to wrong room — ignored`);
        return;
      }
      const session = sessions.get(roomId);
      if (!session?.users.includes(socket.id)) return;

      const payload = {
        id:        `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        senderId:  socket.id,
        message:   message.trim().slice(0, 500),
        timestamp: Date.now(),
      };
      io.to(roomId).emit('receive_message', payload);
      console.log(`[MSG] room ${roomId}: "${payload.message.slice(0, 40)}"`);
    });

    // ── disconnect
  ──────────────────────────────────────────────────────────────
    socket.on('disconnect', reason => {
      console.log(`[DISCONNECT] ${socket.id} (reason: ${reason})`);
      queue = queue.filter(id => id !== socket.id);
      const roomId = socket.data.roomId;
      if (roomId && sessions.has(roomId)) {
        endSession(roomId, 'partner_disconnected');
      }
    });
  });

  // ── Serve index.html for any non-API route
  ────────────────────────────────────
  app.use(express.static(path.join(__dirname)));

  server.listen(PORT, () => {
    console.log(`[SERVER] CrossPath running on http://localhost:${PORT}`);
    console.log(`[SERVER] Health check: http://localhost:${PORT}/health`);
  });
