// =========================
// CrossPath Server (Render-ready)
// =========================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// -------------------------
// Config
// -------------------------
const PORT = process.env.PORT || 3001;
const SESSION_MS = 3 * 60 * 1000; // 3 minutes
const SPARK_EXTENSION_MS = 30 * 1000; // 30 seconds
const MAX_SPARKS = 3;
const FRONTEND_URL = process.env.FRONTEND_URL || '*'; // Set in Render

// -------------------------
// App + Server + Socket
// -------------------------
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// -------------------------
// State
// -------------------------
let queue = [];
const sessions = new Map();
const reactionWindows = new Map();

// -------------------------
// Health Check
// -------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    queue: queue.length,
    sessions: sessions.size
  });
});

// -------------------------
// Matching
// -------------------------
function createSession(id1, id2) {
  const s1 = io.sockets.sockets.get(id1);
  const s2 = io.sockets.sockets.get(id2);

  if (!s1 || !s2) {
    console.log('[MATCH] socket gone - re-queuing');
    if (s1) { s1.data.status = 'queued'; queue.push(id1); }
    if (s2) { s2.data.status = 'queued'; queue.push(id2); }
    return;
  }

  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const startTime = Date.now();
  const endTime = startTime + SESSION_MS;

  [s1, s2].forEach(s => {
    s.join(roomId);
    s.data.status = 'in_session';
    s.data.roomId = roomId;
    s.data.sparksLeft = MAX_SPARKS;
  });

  const timer = setTimeout(() => {
    endSession(roomId, 'timeout');
  }, SESSION_MS);

  sessions.set(roomId, {
    users: [id1, id2],
    timer,
    startTime,
    endTime
  });

  s1.emit('matched', { roomId, startTime, duration: SESSION_MS, partnerUid: s2.data.uid || null });
  s2.emit('matched', { roomId, startTime, duration: SESSION_MS, partnerUid: s1.data.uid || null });

  console.log('[MATCH] paired', id1, id2, 'room:', roomId);
}

function tryMatch() {
  queue = queue.filter(id => {
    const s = io.sockets.sockets.get(id);
    return s && s.data.status === 'queued';
  });

  while (queue.length >= 2) {
    const id1 = queue.shift();
    const id2 = queue.shift();
    createSession(id1, id2);
  }
}

// -------------------------
// Session End
// -------------------------
function endSession(roomId, reason = 'ended') {
  const session = sessions.get(roomId);
  if (!session) return;

  clearTimeout(session.timer);
  sessions.delete(roomId);

  io.to(roomId).emit('session_ended', { reason });

  session.users.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (!s) return;
    s.leave(roomId);
    s.data.status = 'idle';
    s.data.roomId = null;
  });

  console.log('[SESSION] ended', roomId, 'reason', reason);

  if (reason !== 'timeout') return;

  // Open reaction window
  const reactionTimer = setTimeout(() => resolveReaction(roomId, 'cross'), 12000);
  reactionWindows.set(roomId, {
    sockets: session.users,
    votes: {},
    timer: reactionTimer,
    resolved: false
  });

  session.users.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (s) s.data.reactionRoom = roomId;
  });

  console.log('[REACT] window opened for', roomId);
}

// -------------------------
// Reaction
// -------------------------
function resolveReaction(roomId, result) {
  const rw = reactionWindows.get(roomId);
  if (!rw || rw.resolved) return;
  rw.resolved = true;

  clearTimeout(rw.timer);
  reactionWindows.delete(roomId);

  rw.sockets.forEach((id, i) => {
    const s = io.sockets.sockets.get(id);
    if (!s) return;
    s.data.reactionRoom = null;

    const partnerId = rw.sockets[i === 0 ? 1 : 0];
    const partner = io.sockets.sockets.get(partnerId);

    s.emit('reaction_result', {
      result,
      partnerUid: partner?.data.uid || null
    });
  });

  console.log('[REACT] resolved', roomId, 'result', result);
}

// -------------------------
// Socket Connections
// -------------------------
io.on('connection', socket => {
  socket.data = socket.data || {};
  socket.data.status = 'idle';
  socket.data.roomId = null;
  console.log('[CONNECT]', socket.id);

  socket.on('join_queue', data => {
    if (socket.data.status !== 'idle') return;

    socket.data.uid = (data && typeof data.uid === 'string') ? data.uid.slice(0,20) : null;
    socket.data.status = 'queued';

    if (!queue.includes(socket.id)) queue.push(socket.id);

    console.log('[QUEUE] joined', queue.length);
    tryMatch();
  });

  socket.on('leave_queue', () => {
    queue = queue.filter(id => id !== socket.id);
    socket.data.status = 'idle';
    console.log('[QUEUE] left', queue.length);
  });

  socket.on('leave_session', () => {
    const roomId = socket.data.roomId;
    if (roomId && sessions.has(roomId)) endSession(roomId, 'partner_disconnected');
    socket.data.status = 'idle';
  });

  socket.on('send_spark', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !sessions.has(roomId)) return;

    const session = sessions.get(roomId);
    if (!session || socket.data.sparksLeft <= 0) return;

    socket.data.sparksLeft -= 1;
    session.endTime += SPARK_EXTENSION_MS;

    clearTimeout(session.timer);
    const remaining = Math.max(0, session.endTime - Date.now());
    session.timer = setTimeout(() => endSession(roomId, 'timeout'), remaining);

    io.to(roomId).emit('spark_applied', {
      senderId: socket.id,
      newEndTime: session.endTime,
      senderSparksLeft: socket.data.sparksLeft
    });

    console.log('[SPARK]', socket.id, 'sparks left', socket.data.sparksLeft);
  });

  socket.on('send_reaction', data => {
    const reaction = data?.reaction;
    if (!['flame','cross'].includes(reaction)) return;

    const roomId = socket.data.reactionRoom;
    if (!roomId || !reactionWindows.has(roomId)) return;

    const rw = reactionWindows.get(roomId);
    rw.votes[socket.id] = reaction;
    console.log('[REACT] vote', socket.id, reaction);

    const votes = Object.values(rw.votes);
    if (votes.includes('cross')) return resolveReaction(roomId, 'cross');
    if (votes.length === rw.sockets.length) return resolveReaction(roomId, 'mutual_flame');
  });

  socket.on('send_message', data => {
    if (!data?.message || !data.message.trim()) return;

    const session = sessions.get(data.roomId);
    if (!session || !session.users.includes(socket.id)) return;

    const rand = Math.random().toString(36).slice(2,6);
    const payload = {
      id: Date.now() + '_' + rand,
      senderId: socket.id,
      message: data.message.trim().slice(0,500),
      timestamp: Date.now()
    };

    io.to(data.roomId).emit('receive_message', payload);
    console.log('[MSG] sent in', data.roomId);
  });

  socket.on('disconnect', reason => {
    console.log('[DISCONNECT]', socket.id, reason);

    queue = queue.filter(id => id !== socket.id);

    const roomId = socket.data.roomId;
    if (roomId && sessions.has(roomId)) endSession(roomId, 'partner_disconnected');

    const reactionRoom = socket.data.reactionRoom;
    if (reactionRoom && reactionWindows.has(reactionRoom)) resolveReaction(reactionRoom, 'cross');
  });
});

// -------------------------
// Serve Static + Start
// -------------------------
app.use(express.static(path.join(__dirname)));

server.listen(PORT, () => {
  console.log(`[SERVER] running on port ${PORT}`);
});
