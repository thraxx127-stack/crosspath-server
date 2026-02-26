var express = require('express');
var http = require('http');
var Server = require('socket.io').Server;
var path = require('path');

var app = express();
var server = http.createServer(app);

var io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket', 'polling']
});

var PORT = process.env.PORT || 3001;
var SESSION_MS = 3 * 60 * 1000;

var queue = [];
var sessions = new Map();
var reactionWindows = new Map();
var uidMap = new Map();
var dmSessions = new Map();
var pendingRequests = new Map();

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    queue: queue.length,
    sessions: sessions.size
  });
});

function createSession(id1, id2) {
  var s1 = io.sockets.sockets.get(id1);
  var s2 = io.sockets.sockets.get(id2);

  if (!s1 || !s2) {
    console.log('[MATCH] socket gone - re-queuing');
    if (s1) { s1.data.status = 'queued'; if (!queue.includes(id1)) queue.push(id1); }
    if (s2) { s2.data.status = 'queued'; if (!queue.includes(id2)) queue.push(id2); }
    return;
  }

  var roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  var startTime = Date.now();
  var endTime = startTime + SESSION_MS;

  s1.join(roomId);
  s2.join(roomId);

  s1.data.status = 'in_session';
  s2.data.status = 'in_session';
  s1.data.roomId = roomId;
  s2.data.roomId = roomId;
  s1.data.sparksLeft = 3;
  s2.data.sparksLeft = 3;

  var timer = setTimeout(function() {
    endSession(roomId, 'timeout');
  }, SESSION_MS);

  sessions.set(roomId, {
    users: [id1, id2],
    timer: timer,
    startTime: startTime,
    endTime: endTime
  });

  s1.emit('matched', {
    roomId: roomId,
    startTime: startTime,
    duration: SESSION_MS,
    partnerUid: s2.data.uid || null
  });

  s2.emit('matched', {
    roomId: roomId,
    startTime: startTime,
    duration: SESSION_MS,
    partnerUid: s1.data.uid || null
  });

  console.log('[MATCH] paired ' + id1 + ' and ' + id2);
}

function endSession(roomId, reason) {
  if (!reason) reason = 'ended';

  var session = sessions.get(roomId);
  if (!session) return;

  clearTimeout(session.timer);
  io.to(roomId).emit('session_ended', { reason: reason });

  session.users.forEach(function(id) {
    var s = io.sockets.sockets.get(id);
    if (!s) return;
    s.leave(roomId);
    s.data.status = 'idle';
    s.data.roomId = null;
  });

  sessions.delete(roomId);

  if (reason !== 'timeout') return;

  var rTimer = setTimeout(function() {
    resolveReaction(roomId, 'cross');
  }, 12000);

  reactionWindows.set(roomId, {
    sockets: session.users,
    votes: {},
    timer: rTimer
  });

  session.users.forEach(function(id) {
    var s = io.sockets.sockets.get(id);
    if (s) s.data.reactionRoom = roomId;
  });
}

function resolveReaction(roomId, result) {
  var rw = reactionWindows.get(roomId);
  if (!rw) return;

  clearTimeout(rw.timer);
  reactionWindows.delete(roomId);

  rw.sockets.forEach(function(id, index) {
    var s = io.sockets.sockets.get(id);
    if (!s) return;

    s.data.reactionRoom = null;

    var partnerId = rw.sockets[index === 0 ? 1 : 0];
    var partner = io.sockets.sockets.get(partnerId);
    var pUid = partner ? partner.data.uid || null : null;

    s.emit('reaction_result', {
      result: result,
      partnerUid: pUid
    });
  });
}

function endDmSession(dmRoomId, reason) {
  var dms = dmSessions.get(dmRoomId);
  if (!dms) return;

  dmSessions.delete(dmRoomId);
  io.to(dmRoomId).emit('dm_ended', { reason: reason });

  dms.users.forEach(function(id) {
    var s = io.sockets.sockets.get(id);
    if (!s) return;
    s.leave(dmRoomId);
    s.data.dmRoomId = null;
  });
}

function tryMatch() {
  queue = queue.filter(function(id) {
    var s = io.sockets.sockets.get(id);
    return s && s.data.status === 'queued';
  });

  if (queue.length >= 2) {
    var id1 = queue.shift();
    var id2 = queue.shift();
    createSession(id1, id2);
  }
}

io.on('connection', function(socket) {

  // SAFE INITIALIZATION
  socket.data = socket.data || {};
  socket.data.status = 'idle';
  socket.data.roomId = null;
  socket.data.dmRoomId = null;
  socket.data.reactionRoom = null;

  console.log('[CONNECT] ' + socket.id);

  socket.on('join_queue', function(data) {
    if (socket.data.status !== 'idle') return;

    if (data && typeof data.uid === 'string') {
      socket.data.uid = data.uid.slice(0, 20);
      uidMap.set(socket.data.uid, socket.id);
    }

    socket.data.status = 'queued';

    if (!queue.includes(socket.id)) {
      queue.push(socket.id);
    }

    tryMatch();
  });

  socket.on('leave_queue', function() {
    queue = queue.filter(function(id) {
      return id !== socket.id;
    });
    socket.data.status = 'idle';
  });

  socket.on('send_spark', function() {
    var roomId = socket.data.roomId;
    if (!roomId || !sessions.has(roomId)) return;

    var session = sessions.get(roomId);
    if (!session) return;

    if (!socket.data.sparksLeft || socket.data.sparksLeft <= 0) return;

    socket.data.sparksLeft -= 1;

    session.endTime += 30000;
    clearTimeout(session.timer);

    var remaining = Math.max(0, session.endTime - Date.now());

    session.timer = setTimeout(function() {
      endSession(roomId, 'timeout');
    }, remaining);

    io.to(roomId).emit('spark_applied', {
      senderId: socket.id,
      newEndTime: session.endTime,
      senderSparksLeft: socket.data.sparksLeft
    });
  });

  socket.on('disconnect', function(reason) {

    queue = queue.filter(function(id) {
      return id !== socket.id;
    });

    var roomId = socket.data.roomId;
    if (roomId && sessions.has(roomId)) {
      endSession(roomId, 'partner_disconnected');
    }

    var reactionRoom = socket.data.reactionRoom;
    if (reactionRoom && reactionWindows.has(reactionRoom)) {
      resolveReaction(reactionRoom, 'cross');
    }

    var dmRoomId = socket.data.dmRoomId;
    if (dmRoomId && dmSessions.has(dmRoomId)) {
      endDmSession(dmRoomId, 'partner_offline');
    }

    if (socket.data.uid && uidMap.get(socket.data.uid) === socket.id) {
      uidMap.delete(socket.data.uid);
    }

    console.log('[DISCONNECT] ' + socket.id + ' ' + reason);
  });
});

app.use(express.static(path.join(__dirname)));

server.listen(PORT, function() {
  console.log('[SERVER] running on port ' + PORT);
});
