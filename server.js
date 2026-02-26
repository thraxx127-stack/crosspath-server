const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3001;
const SESSION_MS = 3 * 60 * 1000;

let queue = [];
const sessions = new Map();
const reactionWindows = new Map();
const uidMap = new Map();
const dmSessions = new Map();
const pendingRequests = new Map();

/* ---------------- HEALTH ROUTES ---------------- */

app.get('/', (req, res) => {
  res.send('CrossPath server running.');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    queue: queue.length,
    sessions: sessions.size
  });
});

/* ---------------- SESSION CREATION ---------------- */

function createSession(id1, id2) {
  const s1 = io.sockets.sockets.get(id1);
  const s2 = io.sockets.sockets.get(id2);

  if (!s1 || !s2) {
    if (s1) {
      s1.data.status = 'queued';
      if (!queue.includes(id1)) queue.push(id1);
    }
    if (s2) {
      s2.data.status = 'queued';
      if (!queue.includes(id2)) queue.push(id2);
    }
    return;
  }

  const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const startTime = Date.now();
  const endTime = startTime + SESSION_MS;

  s1.join(roomId);
  s2.join(roomId);

  s1.data.status = 'in_session';
  s2.data.status = 'in_session';
  s1.data.roomId = roomId;
  s2.data.roomId = roomId;
  s1.data.sparksLeft = 3;
  s2.data.sparksLeft = 3;

  const timer = setTimeout(() => {
    endSession(roomId, 'timeout');
  }, SESSION_MS);

  sessions.set(roomId, {
    users: [id1, id2],
    timer,
    startTime,
    endTime
  });

  s1.emit('matched', {
    roomId,
    startTime,
    duration: SESSION_MS,
    partnerUid: s2.data.uid || null
  });

  s2.emit('matched', {
    roomId,
    startTime,
    duration: SESSION_MS,
    partnerUid: s1.data.uid || null
  });

  console.log('[MATCH]', id1, id2);
}

/* ---------------- END SESSION ---------------- */

function endSession(roomId, reason = 'ended') {
  const session = sessions.get(roomId);
  if (!session) return;

  clearTimeout(session.timer);
  io.to(roomId).emit('session_ended', { reason });

  session.users.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (!s) return;

    s.leave(roomId);
    s.data.status = 'idle';
    s.data.roomId = null;
  });

  sessions.delete(roomId);

  if (reason !== 'timeout') return;

  const reactionTimer = setTimeout(() => {
    resolveReaction(roomId, 'cross');
  }, 12000);

  reactionWindows.set(roomId, {
    sockets: session.users,
    votes: {},
    timer: reactionTimer
  });

  session.users.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (s) s.data.reactionRoom = roomId;
  });
}

/* ---------------- REACTION RESOLUTION ---------------- */

function resolveReaction(roomId, result) {
  const rw = reactionWindows.get(roomId);
  if (!rw) return;

  clearTimeout(rw.timer);
  reactionWindows.delete(roomId);

  rw.sockets.forEach((id, index) => {
    const s = io.sockets.sockets.get(id);
    if (!s) return;

    s.data.reactionRoom = null;

    const partnerId = rw.sockets[index === 0 ? 1 : 0];
    const partner = io.sockets.sockets.get(partnerId);
    const partnerUid = partner?.data?.uid || null;

    s.emit('reaction_result', {
      result,
      partnerUid
    });
  });
}

/* ---------------- MATCHMAKING ---------------- */

function tryMatch() {
  queue = queue.filter(id => {
    const s = io.sockets.sockets.get(id);
    return s && s.data.status === 'queued';
  });

  if (queue.length >= 2) {
    const id1 = queue.shift();
    const id2 = queue.shift();
    createSession(id1, id2);
  }
}

/* ---------------- SOCKET CONNECTION ---------------- */

io.on('connection', socket => {

  // SAFE DATA INIT
  socket.data = socket.data || {};
  socket.data.status = 'idle';
  socket.data.roomId = null;
  socket.data.dmRoomId = null;
  socket.data.reactionRoom = null;

  console.log('[CONNECT]', socket.id);

  socket.on('join_queue', data => {
    if (socket.data.status !== 'idle') return;

    if (data?.uid && typeof data.uid === 'string') {
      socket.data.uid = data.uid.slice(0, 30);
      uidMap.set(socket.data.uid, socket.id);
    }

    socket.data.status = 'queued';

    if (!queue.includes(socket.id)) {
      queue.push(socket.id);
    }

    tryMatch();
  });

  socket.on('leave_queue', () => {
    queue = queue.filter(id => id !== socket.id);
    socket.data.status = 'idle';
  });

  socket.on('send_spark', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !sessions.has(roomId)) return;

    const session = sessions.get(roomId);
    if (!session) return;

    if (!socket.data.sparksLeft || socket.data.sparksLeft <= 0) return;

    socket.data.sparksLeft -= 1;

    session.endTime += 30000;
    clearTimeout(session.timer);

    const remaining = Math.max(0, session.endTime - Date.now());

    session.timer = setTimeout(() => {
      endSession(roomId, 'timeout');
    }, remaining);

    io.to(roomId).emit('spark_applied', {
      senderId: socket.id,
      newEndTime: session.endTime,
      senderSparksLeft: socket.data.sparksLeft
    });
  });

  socket.on('disconnect', reason => {
    queue = queue.filter(id => id !== socket.id);

    const roomId = socket.data.roomId;
    if (roomId && sessions.has(roomId)) {
      endSession(roomId, 'partner_disconnected');
    }

    const reactionRoom = socket.data.reactionRoom;
    if (reactionRoom && reactionWindows.has(reactionRoom)) {
      resolveReaction(reactionRoom, 'cross');
    }

    if (socket.data.uid && uidMap.get(socket.data.uid) === socket.id) {
      uidMap.delete(socket.data.uid);
    }

    console.log('[DISCONNECT]', socket.id, reason);
  });
});
