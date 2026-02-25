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
  var reactionWindows = new Map();

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

    var endTime = startTime + SESSION_MS;
    s1.data.sparksLeft = 3;
    s2.data.sparksLeft = 3;
    var timer = setTimeout(function() { endSession(roomId, 'timeout'); },
  SESSION_MS);
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

    if (reason !== 'timeout') { return; }

    var rTimer = setTimeout(function() {
      resolveReaction(roomId, 'cross');
    }, 12000);
    reactionWindows.set(roomId, {
      sockets: users,
      votes: {},
      timer: rTimer
    });
    for (var j = 0; j < users.length; j++) {
      var rs = io.sockets.sockets.get(users[j]);
      if (rs) { rs.data.reactionRoom = roomId; }
    }
    console.log('[REACT] window opened for ' + roomId);
  }

  function resolveReaction(roomId, result) {
    var rw = reactionWindows.get(roomId);
    if (!rw) { return; }
    clearTimeout(rw.timer);
    reactionWindows.delete(roomId);
    for (var i = 0; i < rw.sockets.length; i++) {
      var s = io.sockets.sockets.get(rw.sockets[i]);
      if (!s) { continue; }
      s.data.reactionRoom = null;
      var partnerIdx = i === 0 ? 1 : 0;
      var partner = io.sockets.sockets.get(rw.sockets[partnerIdx]);
      var pUid = partner ? (partner.data.uid || null) : null;
      s.emit('reaction_result', {
        result: result,
        partnerUid: pUid
      });
    }
    console.log('[REACT] resolved ' + roomId + ' result ' + result);
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

    socket.on('send_spark', function() {
      var roomId = socket.data.roomId;
      if (!roomId || !sessions.has(roomId)) { return; }
      if (!socket.data.sparksLeft || socket.data.sparksLeft <= 0) { return; }
      var session = sessions.get(roomId);
      socket.data.sparksLeft = socket.data.sparksLeft - 1;
      session.endTime = session.endTime + 30000;
      clearTimeout(session.timer);
      var remaining = session.endTime - Date.now();
      session.timer = setTimeout(function() {
        endSession(roomId, 'timeout');
      }, remaining);
      io.to(roomId).emit('spark_applied', {
        senderId: socket.id,
        newEndTime: session.endTime,
        senderSparksLeft: socket.data.sparksLeft
      });
      console.log('[SPARK] ' + socket.id + ' sparks left ' +
  socket.data.sparksLeft);
    });

    socket.on('leave_queue', function() {
      queue = queue.filter(function(id) { return id !== socket.id; });
      socket.data.status = 'idle';
      console.log('[QUEUE] left size ' + queue.length);
    });

    socket.on('send_reaction', function(data) {
      var reaction = data && data.reaction;
      if (reaction !== 'flame' && reaction !== 'cross') { return; }
      var roomId = socket.data.reactionRoom;
      if (!roomId || !reactionWindows.has(roomId)) { return; }
      var rw = reactionWindows.get(roomId);
      rw.votes[socket.id] = reaction;
      console.log('[REACT] ' + socket.id + ' voted ' + reaction);
      var vKeys = Object.keys(rw.votes);
      var hasCross = vKeys.some(function(k) { return rw.votes[k] === 'cross';
  });
      if (hasCross) {
        resolveReaction(roomId, 'cross');
        return;
      }
      if (vKeys.length === rw.sockets.length) {
        resolveReaction(roomId, 'mutual_flame');
      }
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
      var reactionRoom = socket.data.reactionRoom;
      if (reactionRoom && reactionWindows.has(reactionRoom)) {
        resolveReaction(reactionRoom, 'cross');
      }
    });
  });
