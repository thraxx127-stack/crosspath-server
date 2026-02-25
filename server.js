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
let sessions = new Map();
let reactionWindows = new Map();
let uidMap = new Map();
let dmSessions = new Map();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    queue: queue.length,
    sessions: sessions.size
  });
});

// ---- SESSION / MATCHMAKING ----
function createSession(id1, id2) {
  const s1 = io.sockets.sockets.get(id1);
  const s2 = io.sockets.sockets.get(id2);

  if (!s1 || !s2) {
    if (s1) { s1.data.status = 'queued'; queue.push(id1); }
    if (s2) { s2.data.status = 'queued'; queue.push(id2); }
    console.log('[MATCH] socket missing, re-queuing');
    return;
  }

  const rand = Math.random().toString(36).slice(2, 9);
  const roomId = `room_${Date.now()}_${rand}`;
  const startTime = Date.now();

  [s1, s2].forEach(s => {
    s.join(roomId);
    s.data.status = 'in_session';
    s.data.roomId = roomId;
    s.data.sparksLeft = 3;
  });

  const timer = setTimeout(() => endSession(roomId, 'timeout'), SESSION_MS);

  sessions.set(roomId, {
    users: [id1, id2],
    timer,
    startTime,
    endTime: startTime + SESSION_MS
  });

  s1.emit('matched', { roomId, startTime, duration: SESSION_MS, partnerUid: s2.data.uid || null });
  s2.emit('matched', { roomId, startTime, duration: SESSION_MS, partnerUid: s1.data.uid || null });

  console.log(`[MATCH] paired ${id1} & ${id2}, room: ${roomId}`);
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
  console.log(`[SESSION] ended ${roomId} (${reason})`);

  // If session timed out, open reaction window
  if (reason === 'timeout') {
    const rTimer = setTimeout(() => resolveReaction(roomId, 'cross'), 12000);
    reactionWindows.set(roomId, { sockets: session.users, votes: {}, timer: rTimer });
    session.users.forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (s) s.data.reactionRoom = roomId;
    });
    console.log(`[REACT] window opened for ${roomId}`);
  }
}

function resolveReaction(roomId, result) {
  const rw = reactionWindows.get(roomId);
  if (!rw) return;

  clearTimeout(rw.timer);
  reactionWindows.delete(roomId);

  rw.sockets.forEach((id, idx) => {
    const s = io.sockets.sockets.get(id);
    if (!s) return;
    s.data.reactionRoom = null;
    const partner = io.sockets.sockets.get(rw.sockets[idx === 0 ? 1 : 0]);
    const pUid = partner ? partner.data.uid || null : null;
    s.emit('reaction_result', { result, partnerUid: pUid });
  });

  console.log(`[REACT] resolved ${roomId} as ${result}`);
}

// ---- DM HANDLING ----
function endDmSession(dmRoomId, reason) {
  const dms = dmSessions.get(dmRoomId);
  if (!dms) return;

  dmSessions.delete(dmRoomId);
  io.to(dmRoomId).emit('dm_ended', { reason });

  dms.users.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (s) {
      s.leave(dmRoomId);
      s.data.dmRoomId = null;
    }
  });

  console.log(`[DM] ended ${dmRoomId} (${reason})`);
}

// ---- QUEUE ----
function tryMatch() {
  queue = queue.filter(id => {
    const s = io.sockets.sockets.get(id);
    return s && s.data.status === 'queued';
  });

  if (queue.length >= 2) {
    const id1 = queue.shift();
    const id2 = queue.shift();
    createSession(id1, id2);
  } else {
    console.log(`[QUEUE] waiting for second user, size: ${queue.length}`);
  }
}

// ---- SOCKET CONNECTION ----
io.on('connection', (socket) => {
  socket.data = { status: 'idle', roomId: null, dmRoomId: null };
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('register_uid', (data) => {
    if (!data || typeof data.uid !== 'string') return;
    const uid = data.uid.slice(0, 20);
    socket.data.uid = uid;
    uidMap.set(uid, socket.id);
    console.log(`[UID] registered ${uid}`);
  });

  socket.on('join_queue', (data) => {
    if (socket.data.status !== 'idle') return;
    socket.data.uid = data && typeof data.uid === 'string' ? data.uid.slice(0, 20) : null;
    socket.data.status = 'queued';
    queue.push(socket.id);
    console.log(`[QUEUE] joined, size: ${queue.length}`);
    tryMatch();
  });

  socket.on('leave_queue', () => {
    queue = queue.filter(id => id !== socket.id);
    socket.data.status = 'idle';
    console.log(`[QUEUE] left, size: ${queue.length}`);
  });

  socket.on('leave_session', () => {
    const roomId = socket.data.roomId;
    if (roomId && sessions.has(roomId)) endSession(roomId, 'partner_disconnected');
    socket.data.status = 'idle';
  });

  socket.on('send_spark', () => {
    const roomId = socket.data.roomId;
    const session = roomId && sessions.get(roomId);
    if (!session || !socket.data.sparksLeft || socket.data.sparksLeft <= 0) return;

    socket.data.sparksLeft--;
    session.endTime += 30000;
    clearTimeout(session.timer);

    const remaining = session.endTime - Date.now();
    session.timer = setTimeout(() => endSession(roomId, 'timeout'), remaining);

    io.to(roomId).emit('spark_applied', {
      senderId: socket.id,
      newEndTime: session.endTime,
      senderSparksLeft: socket.data.sparksLeft
    });

    console.log(`[SPARK] ${socket.id}, sparks left: ${socket.data.sparksLeft}`);
  });

  socket.on('send_reaction', (data) => {
    if (!data || (data.reaction !== 'flame' && data.reaction !== 'cross')) return;
    const roomId = socket.data.reactionRoom;
    if (!roomId || !reactionWindows.has(roomId)) return;

    const rw = reactionWindows.get(roomId);
    rw.votes[socket.id] = data.reaction;

    if (Object.values(rw.votes).includes('cross')) return resolveReaction(roomId, 'cross');
    if (Object.keys(rw.votes).length === rw.sockets.length) resolveReaction(roomId, 'mutual_flame');

    console.log(`[REACT] ${socket.id} voted ${data.reaction}`);
  });

  socket.on('send_message', (data) => {
    if (!data || !data.message?.trim()) return;
    const session = sessions.get(data.roomId);
    if (!session || !session.users.includes(socket.id)) return;

    const payload = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      senderId: socket.id,
      message: data.message.trim().slice(0, 500),
      timestamp: Date.now()
    };

    io.to(data.roomId).emit('receive_message', payload);
    console.log(`[MSG] ${socket.id} sent message in ${data.roomId}`);
  });

  socket.on('dm_open', (data) => {
    if (!data || typeof data.targetUid !== 'string') return;
    const tId = uidMap.get(data.targetUid.slice(0, 20));
    const ts = tId ? io.sockets.sockets.get(tId) : null;
    if (!ts) return socket.emit('dm_error', { reason: 'offline' });

    const dmRoomId = `dm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    [socket, ts].forEach(s => { s.data.dmRoomId = dmRoomId; s.join(dmRoomId); });

    dmSessions.set(dmRoomId, { users: [socket.id, tId] });

    socket.emit('dm_ready', { dmRoomId, partnerUid: data.targetUid });
    ts.emit('dm_ready', { dmRoomId, partnerUid: socket.data.uid });

    console.log(`[DM] opened ${dmRoomId}`);
  });

  socket.on('dm_message', (data) => {
    if (!data?.message?.trim()) return;
    const dmRoomId = socket.data.dmRoomId;
    if (!dmRoomId || dmSessions.get(dmRoomId) === undefined || dmRoomId !== data.dmRoomId) return;

    const payload = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      senderId: socket.id,
      message: data.message.trim(),
      timestamp: Date.now()
    };

    io.to(dmRoomId).emit('dm_receive', payload);
    console.log(`[DM] message in ${dmRoomId}`);
  });

  socket.on('dm_end', () => {
    const dmRoomId = socket.data.dmRoomId;
    if (dmRoomId && dmSessions.has(dmRoomId)) endDmSession(dmRoomId, 'ended');
  });

  socket.on('disconnect', () => {
    queue = queue.filter(id => id !== socket.id);
    const { roomId, reactionRoom, dmRoomId, uid } = socket.data;

    if (roomId && sessions.has(roomId)) endSession(roomId, 'partner_disconnected');
    if (reactionRoom && reactionWindows.has(reactionRoom)) resolveReaction(reactionRoom, 'cross');
    if (dmRoomId && dmSessions.has(dmRoomId)) endDmSession(dmRoomId, 'partner_offline');
    if (uid && uidMap.get(uid) === socket.id) uidMap.delete(uid);

    console.log(`[DISCONNECT] ${socket.id}`);
  });
});

app.use(express.static(path.join(__dirname)));

server.listen(PORT, () => {
  console.log(`[SERVER] running on port ${PORT}`);
});
