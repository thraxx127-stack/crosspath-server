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
  var pendingFlameRequests = new Map();

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
      if (s1) { s1.data.status = 'queued'; queue.push(id1); }
      if (s2) { s2.data.status = 'queued'; queue.push(id2); }
      return;
    }

    var rand = Math.random().toString(36).slice(2, 9);
    var roomId = 'room_' + Date.now() + '_' + rand;
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
    console.log('[SESSION] started room ' + roomId);
  }

  function endSession(roomId, reason) {
    if (!reason) { reason = 'ended'; }
    var session = sessions.get(roomId);
    if (!session) { return; }

    clearTimeout(session.timer);
    var users = session.users;
    var frDel = [];
    pendingFlameRequests.forEach(function(req, rid) {
      if (req.roomId === roomId) { frDel.push(rid); }
    });
    for (var f = 0; f < frDel.length; f++) {
      pendingFlameRequests.delete(frDel[f]);
    }
    for (var n = 0; n < users.length; n++) {
      var su = io.sockets.sockets.get(users[n]);
      if (su) { su.emit('session_ended', { reason: reason }); }
    }
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

  function endDmSession(dmRoomId, reason) {
    var dms = dmSessions.get(dmRoomId);
    if (!dms) { return; }
    dmSessions.delete(dmRoomId);
    io.to(dmRoomId).emit('dm_ended', { reason: reason });
    for (var i = 0; i < dms.users.length; i++) {
      var s = io.sockets.sockets.get(dms.users[i]);
      if (s) {
        s.leave(dmRoomId);
        s.data.dmRoomId = null;
      }
    }
    console.log('[DM] ended ' + dmRoomId + ' ' + reason);
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
    if (queue.length < 2) {
      console.log('[QUEUE] waiting for more users');
      return;
    }
    var id1 = null;
    var id2 = null;
    var i1 = -1;
    var i2 = -1;
    for (var i = 0; i < queue.length; i++) {
      if (id1) { break; }
      var sA = io.sockets.sockets.get(queue[i]);
      if (!sA) { continue; }
      var uidA = sA.data.uid || null;
      var blA  = sA.data.blockList || [];
      for (var j = i + 1; j < queue.length; j++) {
        var sB = io.sockets.sockets.get(queue[j]);
        if (!sB) { continue; }
        var uidB = sB.data.uid || null;
        var blB  = sB.data.blockList || [];
        var skip =
          (uidB && blA.indexOf(uidB) !== -1) ||
          (uidA && blB.indexOf(uidA) !== -1);
        if (!skip) {
          id1 = queue[i];
          id2 = queue[j];
          i1 = i;
          i2 = j;
          break;
        }
      }
    }
    if (!id1) {
      console.log('[QUEUE] no compatible pair found');
      return;
    }
    queue.splice(i2, 1);
    queue.splice(i1, 1);
    createSession(id1, id2);
  }

  io.on('connection', function(socket) {
    socket.data.status = 'idle';
    socket.data.roomId = null;
    socket.data.dmRoomId = null;
    console.log('[CONNECT] ' + socket.id);

    socket.on('register_uid', function(data) {
      var isStr = data && typeof data.uid === 'string';
      if (!isStr) { return; }
      var uid = data.uid.slice(0, 20);
      socket.data.uid = uid;
      uidMap.set(uid, socket.id);
      console.log('[UID] registered ' + uid);
    });

    socket.on('join_queue', function(data) {
      if (socket.data.status !== 'idle') {
        console.log('[QUEUE] ignored - status ' + socket.data.status);
        return;
      }
      var isStr = data && typeof data.uid === 'string';
      var uid = isStr ? data.uid : null;
      socket.data.uid = uid ? uid.slice(0, 20) : null;
      if (socket.data.uid) {
        uidMap.set(socket.data.uid, socket.id);
      }
      socket.data.blockList = [];
      var bIsArr = Array.isArray(data.blockList);
      if (bIsArr) {
        var bRaw = data.blockList.slice(0, 50);
        socket.data.blockList = bRaw.filter(function(x) {
          return typeof x === 'string';
        });
      }
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
      var sparks = socket.data.sparksLeft;
      if (!sparks || sparks <= 0) { return; }
      var session = sessions.get(roomId);
      socket.data.sparksLeft = sparks - 1;
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
      console.log('[SPARK] ' + socket.id +
        ' sparks left ' + socket.data.sparksLeft);
    });

    socket.on('leave_queue', function() {
      queue = queue.filter(function(id) {
        return id !== socket.id;
      });
      socket.data.status = 'idle';
      console.log('[QUEUE] left size ' + queue.length);
    });

    socket.on('send_reaction', function(data) {
      var reaction = data && data.reaction;
      if (reaction !== 'flame' && reaction !== 'cross') {
        return;
      }
      var roomId = socket.data.reactionRoom;
      if (!roomId || !reactionWindows.has(roomId)) { return; }
      var rw = reactionWindows.get(roomId);
      rw.votes[socket.id] = reaction;
      console.log('[REACT] ' + socket.id + ' voted ' + reaction);
      var vKeys = Object.keys(rw.votes);
      var hasCross = vKeys.some(function(k) {
        return rw.votes[k] === 'cross';
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
      if (!data || !data.message) { return; }
      if (!data.message.trim()) { return; }
      var roomId = socket.data.roomId;
      if (!roomId) { return; }
      var session = sessions.get(roomId);
      if (!session) { return; }
      if (!session.users.includes(socket.id)) { return; }
      var rand = Math.random().toString(36).slice(2, 6);
      var payload = {
        id: Date.now() + '_' + rand,
        senderId: socket.id,
        message: data.message.trim().slice(0, 500),
        timestamp: Date.now()
      };
      for (var mi = 0; mi < session.users.length; mi++) {
        var ts = io.sockets.sockets.get(session.users[mi]);
        if (ts) { ts.emit('receive_message', payload); }
      }
      console.log('[MSG] sent in ' + roomId);
    });

    socket.on('dm_request', function(data) {
      var isStr = data && typeof data.targetUid === 'string';
      if (!isStr) { return; }
      var tUid = data.targetUid.slice(0, 20);
      var tId = uidMap.get(tUid);
      var ts = tId ? io.sockets.sockets.get(tId) : null;
      if (!ts) {
        socket.emit('dm_error', { reason: 'offline' });
        return;
      }
      var rand = Math.random().toString(36).slice(2, 9);
      var reqId = 'req_' + Date.now() + '_' + rand;
      var fromUid = socket.data.uid || null;
      pendingRequests.set(reqId, {
        from: socket.id,
        to: tId,
        fromUid: fromUid
      });
      ts.emit('dm_incoming', {
        requestId: reqId,
        fromUid: fromUid
      });
      console.log('[DM] request ' + reqId);
    });

    socket.on('dm_accept', function(data) {
      var reqId = data && data.requestId ? data.requestId : null;
      if (!reqId) { return; }
      var req = pendingRequests.get(reqId);
      if (!req) { return; }
      if (req.to !== socket.id) { return; }
      pendingRequests.delete(reqId);
      var fs = io.sockets.sockets.get(req.from);
      if (!fs) { return; }
      var rand = Math.random().toString(36).slice(2, 9);
      var dmRoomId = 'dm_' + Date.now() + '_' + rand;
      socket.data.dmRoomId = dmRoomId;
      fs.data.dmRoomId = dmRoomId;
      socket.join(dmRoomId);
      fs.join(dmRoomId);
      var acceptUid = socket.data.uid || null;
      fs.emit('dm_ready', {
        dmRoomId: dmRoomId,
        partnerUid: acceptUid
      });
      socket.emit('dm_ready', {
        dmRoomId: dmRoomId,
        partnerUid: req.fromUid
      });
      dmSessions.set(dmRoomId, {
        users: [req.from, socket.id]
      });
      console.log('[DM] accepted ' + reqId);
    });

    socket.on('dm_decline', function(data) {
      var reqId = data && data.requestId ? data.requestId : null;
      if (!reqId) { return; }
      var req = pendingRequests.get(reqId);
      if (!req) { return; }
      if (req.to !== socket.id) { return; }
      pendingRequests.delete(reqId);
      var fs = io.sockets.sockets.get(req.from);
      if (fs) { fs.emit('dm_declined', {}); }
      console.log('[DM] declined ' + reqId);
    });

    socket.on('flame_request', function() {
      var roomId = socket.data.roomId;
      if (!roomId || !sessions.has(roomId)) { return; }
      var session = sessions.get(roomId);
      var partnerId = null;
      for (var fi = 0; fi < session.users.length; fi++) {
        if (session.users[fi] !== socket.id) {
          partnerId = session.users[fi];
          break;
        }
      }
      if (!partnerId) { return; }
      var rand = Math.random().toString(36).slice(2, 9);
      var reqId = 'fr_' + Date.now() + '_' + rand;
      var fromUid = socket.data.uid || null;
      pendingFlameRequests.set(reqId, {
        from: socket.id,
        to: partnerId,
        roomId: roomId,
        fromUid: fromUid
      });
      var ps = io.sockets.sockets.get(partnerId);
      if (ps) {
        ps.emit('flame_incoming', {
          requestId: reqId,
          fromUid: fromUid
        });
      }
      console.log('[FLAME] request ' + reqId);
    });

    socket.on('flame_accept', function(data) {
      var reqId = data && data.requestId ? data.requestId : null;
      if (!reqId) { return; }
      var req = pendingFlameRequests.get(reqId);
      if (!req) { return; }
      if (req.to !== socket.id) { return; }
      pendingFlameRequests.delete(reqId);
      var acceptUid = socket.data.uid || null;
      var fromUid = req.fromUid || null;
      var fs = io.sockets.sockets.get(req.from);
      if (fs) {
        fs.emit('flame_accepted', { partnerUid: acceptUid });
      }
      socket.emit('flame_accepted', { partnerUid: fromUid });
      console.log('[FLAME] accepted ' + reqId);
    });

    socket.on('flame_decline', function(data) {
      var reqId = data && data.requestId ? data.requestId : null;
      if (!reqId) { return; }
      var req = pendingFlameRequests.get(reqId);
      if (!req) { return; }
      if (req.to !== socket.id) { return; }
      pendingFlameRequests.delete(reqId);
      var fs = io.sockets.sockets.get(req.from);
      if (fs) { fs.emit('flame_declined', {}); }
      console.log('[FLAME] declined ' + reqId);
    });

    socket.on('dm_message', function(data) {
      if (!data || !data.message) { return; }
      if (!data.message.trim()) { return; }
      var dmRoomId = socket.data.dmRoomId;
      if (!dmRoomId) { return; }
      if (!dmSessions.has(dmRoomId)) { return; }
      if (dmRoomId !== data.dmRoomId) { return; }
      var rand = Math.random().toString(36).slice(2, 6);
      var payload = {
        id: Date.now() + '_' + rand,
        senderId: socket.id,
        message: data.message.trim().slice(0, 500),
        timestamp: Date.now()
      };
      io.to(dmRoomId).emit('dm_receive', payload);
      console.log('[DM] msg in ' + dmRoomId);
    });

    socket.on('dm_end', function() {
      var dmRoomId = socket.data.dmRoomId;
      if (dmRoomId && dmSessions.has(dmRoomId)) {
        endDmSession(dmRoomId, 'ended');
      }
    });

    socket.on('disconnect', function(reason) {
      console.log('[DISCONNECT] ' + socket.id + ' ' + reason);
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
      var dmrId = socket.data.dmRoomId;
      if (dmrId && dmSessions.has(dmrId)) {
        endDmSession(dmrId, 'partner_offline');
      }
      var sUid = socket.data.uid;
      if (sUid && uidMap.get(sUid) === socket.id) {
        uidMap.delete(sUid);
      }
      var toDelete = [];
      pendingRequests.forEach(function(req, reqId) {
        if (req.from === socket.id || req.to === socket.id) {
          toDelete.push({ reqId: reqId, req: req });
        }
      });
      for (var p = 0; p < toDelete.length; p++) {
        var pr = toDelete[p];
        pendingRequests.delete(pr.reqId);
        if (pr.req.to === socket.id) {
          var pf = io.sockets.sockets.get(pr.req.from);
          if (pf) { pf.emit('dm_declined', {}); }
        }
      }
      var frToDelete = [];
      pendingFlameRequests.forEach(function(req, rid) {
        if (req.from === socket.id || req.to === socket.id) {
          frToDelete.push(rid);
        }
      });
      for (var fr = 0; fr < frToDelete.length; fr++) {
        pendingFlameRequests.delete(frToDelete[fr]);
      }
    });
  });

  app.use(express.static(path.join(__dirname)));

  server.listen(PORT, function() {
    console.log('[SERVER] running on port ' + PORT);
  });
