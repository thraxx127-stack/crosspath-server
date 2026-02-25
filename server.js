  var express = require('express');                                             
  var http = require('http');                                                   
  var Server = require('socket.io').Server;                                     
  var path = require('path');                                                   
                                                                                
  var app = express();
  var server = http.createServer(app);                                          
                                                                                
  var io = new Server(server, {                                                 
    cors: { origin: '*', methods: ['GET', 'POST'], credentials: false },
    transports: ['websocket', 'polling']
  });

  var PORT = process.env.PORT || 3001;
  var SESSION_MS = 3 * 60 * 1000;

  var queue = [];
  var sessions = new Map();

  app.get('/health', function(req, res) {
    res.json({ status: 'ok', queue: queue.length, sessions: sessions.size });
  });

  function createSession(id1, id2) {
    var s1 = io.sockets.sockets.get(id1);
    var s2 = io.sockets.sockets.get(id2);

    if (!s1 || !s2) {
      console.log('[MATCH] socket gone - re-queuing');
      if (s1) { s1.data.status = 'queued'; queue.push(id1); }
      if (s2) { s2.data.status = 'queued'; queue.push(id2); }
      return;
    }

    var roomId = 'room_' + Date.now() + '_' +
  Math.random().toString(36).slice(2, 9);
    var startTime = Date.now();

    s1.join(roomId);
    s1.data.status = 'in_session';
    s1.data.roomId = roomId;

    s2.join(roomId);
    s2.data.status = 'in_session';
    s2.data.roomId = roomId;

    var timer = setTimeout(function() { endSession(roomId, 'timeout'); },
  SESSION_MS);
    sessions.set(roomId, { users: [id1, id2], timer: timer, startTime: startTime
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
    console.log('[SESSION] started room ' + roomId);
  }

  function endSession(roomId, reason) {
    if (!reason) { reason = 'ended'; }
    var session = sessions.get(roomId);
    if (!session) { return; }

    clearTimeout(session.timer);
    io.to(roomId).emit('session_ended', { reason: reason });

    var users = session.users;
    for (var i = 0; i < users.length; i++) {
      var s = io.sockets.sockets.get(users[i]);
      if (s) {
        s.leave(roomId);
        s.data.status = 'idle';
        s.data.roomId = null;
      }
    }

    sessions.delete(roomId);
    console.log('[SESSION] ended ' + roomId + ' reason ' + reason);
  }

  function tryMatch() {
    var before = queue.length;
    queue = queue.filter(function(id) {
      var s = io.sockets.sockets.get(id);
      return s && s.data.status === 'queued';
    });
    if (queue.length !== before) {
      console.log('[QUEUE] pruned stale entries');
    }
    console.log('[QUEUE] size ' + queue.length);
    if (queue.length >= 2) {
      var id1 = queue.shift();
      var id2 = queue.shift();
      createSession(id1, id2);
    } else {
      console.log('[QUEUE] waiting for second user');
    }
  }

  io.on('connection', function(socket) {
    socket.data.status = 'idle';
    socket.data.roomId = null;
    console.log('[CONNECT] ' + socket.id);

    socket.on('join_queue', function(data) {
      if (socket.data.status !== 'idle') {
        console.log('[QUEUE] ignored - status ' + socket.data.status);
        return;
      }
      var uid = (data && typeof data.uid === 'string') ? data.uid : null;
      socket.data.uid = uid ? uid.slice(0, 20) : null;
      socket.data.status = 'queued';
      queue.push(socket.id);
      console.log('[QUEUE] joined size ' + queue.length);
      tryMatch();
    });

    socket.on('leave_session', function() {
      var roomId = socket.data.roomId;
      if (roomId && sessions.has(roomId)) {
        console.log('[SESSION] early leave ' + socket.id);
        endSession(roomId, 'partner_disconnected');
      }
      socket.data.status = 'idle';
    });

    socket.on('leave_queue', function() {
      queue = queue.filter(function(id) { return id !== socket.id; });
      socket.data.status = 'idle';
      console.log('[QUEUE] left size ' + queue.length);
    });

    socket.on('send_message', function(data) {
      if (!data || !data.message || !data.message.trim()) { return; }
      if (socket.data.roomId !== data.roomId) { return; }
      var session = sessions.get(data.roomId);
      if (!session || !session.users.includes(socket.id)) { return; }
      var payload = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        senderId: socket.id,
        message: data.message.trim().slice(0, 500),
        timestamp: Date.now()
      };
      io.to(data.roomId).emit('receive_message', payload);
      console.log('[MSG] sent in ' + data.roomId);
    });

    socket.on('disconnect', function(reason) {
      console.log('[DISCONNECT] ' + socket.id + ' ' + reason);
      queue = queue.filter(function(id) { return id !== socket.id; });
      var roomId = socket.data.roomId;
      if (roomId && sessions.has(roomId)) {
        endSession(roomId, 'partner_disconnected');
      }
    });
  });

  app.use(express.static(path.join(__dirname)));

  server.listen(PORT, function() {
    console.log('[SERVER] running on port ' + PORT);
  });
