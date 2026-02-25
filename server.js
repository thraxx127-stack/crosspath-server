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
    transports: ['websocket', 'polling'],
  });

  const PORT       = process.env.PORT || 3001;
  const SESSION_MS = 3 * 60 * 1000;

  let queue = [];
  const sessions = new Map();

  app.get('/health', function(_req, res) {
    res.json({ status: 'ok', queue: queue.length, sessions: sessions.size });
  });

  function createSession(id1, id2) {
    var s1 = io.sockets.sockets.get(id1);
    var s2 = io.sockets.sockets.get(id2);

    if (!s1 || !s2) {
      console.log('[MATCH] One socket gone during pairing - re-queuing
  survivors');
      if (s1) { s1.data.status = 'queued'; queue.push(id1); }
      if (s2) { s2.data.status = 'queued'; queue.push(id2); }
      return;
    }

    var roomId    = 'room_' + Date.now() + '_' +
  Math.random().toString(36).slice(2, 9);
    var startTime = Date.now();

    [s1, s2].forEach(function(s) {
      s.join(roomId);
      s.data.status = 'in_session';
      s.data.roomId = roomId;
    });

    var timer = setTimeout(function() { endSession(roomId, 'timeout'); },
  SESSION_MS);
    sessions.set(roomId, { users: [id1, id2], timer: timer, startTime: startTime
   });

    io.to(roomId).emit('matched', { roomId: roomId, startTime: startTime,
  duration: SESSION_MS });

    console.log('[MATCH] Paired ' + id1 + ' and ' + id2 + ' in room ' + roomId);
    console.log('[SESSION] Started - ends in 3 min');
  }

  function endSession(roomId, reason) {
    if (!reason) reason = 'ended';
    var session = sessions.get(roomId);
    if (!session) return;

    clearTimeout(session.timer);
    io.to(roomId).emit('session_ended', { reason: reason });

    session.users.forEach(function(id) {
      var s = io.sockets.sockets.get(id);
      if (s) {
        s.leave(roomId);
        s.data.status = 'idle';
        s.data.roomId = null;
      }
    });

    sessions.delete(roomId);
    console.log('[SESSION] Ended - room ' + roomId + ' reason: ' + reason);
  }

  function tryMatch() {
    var before = queue.length;
    queue = queue.filter(function(id) {
      var s = io.sockets.sockets.get(id);
      return s && s.data.status === 'queued';
    });
    if (queue.length !== before) {
      console.log('[QUEUE] Pruned ' + (before - queue.length) + ' stale
  entries');
    }
    console.log('[QUEUE] Size: ' + queue.length);
    if (queue.length >= 2) {
      var id1 = queue.shift();
      var id2 = queue.shift();
      console.log('[MATCH] Two users ready - creating session');
      createSession(id1, id2);
    } else {
      console.log('[QUEUE] Waiting for second user');
    }
  }

  io.on('connection', function(socket) {
    socket.data.status = 'idle';
    socket.data.roomId = null;
    console.log('[CONNECT] ' + socket.id + ' connected');

    socket.on('join_queue', function() {
      if (socket.data.status !== 'idle') {
        console.log('[QUEUE] ' + socket.id + ' already in status ' +
  socket.data.status + ' - ignored');
        return;
      }
      socket.data.status = 'queued';
      queue.push(socket.id);
      console.log('[QUEUE] ' + socket.id + ' joined - queue size: ' +
  queue.length);
      tryMatch();
    });

    socket.on('leave_session', function() {
      var roomId = socket.data.roomId;
      if (roomId && sessions.has(roomId)) {
        console.log('[SESSION] ' + socket.id + ' left early');
        endSession(roomId, 'partner_disconnected');
      }
      socket.data.status = 'idle';
    });

    socket.on('leave_queue', function() {
      queue = queue.filter(function(id) { return id !== socket.id; });
      socket.data.status = 'idle';
      console.log('[QUEUE] ' + socket.id + ' left - queue size: ' +
  queue.length);
    });

    socket.on('send_message', function(data) {
      var roomId  = data.roomId;
      var message = data.message;
      if (!message || !message.trim()) return;
      if (socket.data.roomId !== roomId) return;
      var session = sessions.get(roomId);
      if (!session || !session.users.includes(socket.id)) return;

      var payload = {
        id:        Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        senderId:  socket.id,
        message:   message.trim().slice(0, 500),
        timestamp: Date.now(),
      };
      io.to(roomId).emit('receive_message', payload);
      console.log('[MSG] room ' + roomId + ': ' + payload.message.slice(0, 40));
    });

    socket.on('disconnect', function(reason) {
      console.log('[DISCONNECT] ' + socket.id + ' reason: ' + reason);
      queue = queue.filter(function(id) { return id !== socket.id; });
      var roomId = socket.data.roomId;
      if (roomId && sessions.has(roomId)) {
        endSession(roomId, 'partner_disconnected');
      }
    });
  });

  app.use(express.static(path.join(__dirname)));

  server.listen(PORT, function() {
    console.log('[SERVER] CrossPath running on port ' + PORT);
    console.log('[SERVER] Health check available at /health');
  });
