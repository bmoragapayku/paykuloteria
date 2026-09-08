'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GameManager } = require('./lib/gameManager');

const PORT = process.env.PORT || 3000;
const AUTOPLAY_INTERVAL_MS = 6000;
// Cuánto tiempo se le guarda el cartón a un jugador que se desconecta
// (por ejemplo, al refrescar la página) antes de liberarlo de verdad.
const RECONNECT_GRACE_MS = 30000;
// Igual, pero para el host: si refresca, la sala sigue viva esperándolo.
const HOST_RECONNECT_GRACE_MS = 60000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const games = new GameManager();

app.use(express.static(path.join(__dirname, 'public')));

// La raíz "/" lleva directo a la pantalla central (TV/monitor)
app.get('/', (_req, res) => {
  res.redirect('/host.html');
});

function roomPublicState(room) {
  return {
    code: room.code,
    status: room.status,
    drawnNumbers: room.drawnNumbers,
    lastNumber: room.drawnNumbers[room.drawnNumbers.length - 1] ?? null,
    players: room.playerSummaries(),
    autoplay: room.autoplay,
    cards: room.cardsSummary(),
  };
}

function stopAutoplay(room) {
  if (room.autoplayTimer) {
    clearInterval(room.autoplayTimer);
    room.autoplayTimer = null;
  }
  room.autoplay = false;
}

function drawAndBroadcast(io, room) {
  const drawn = room.drawNumber();
  if (drawn == null) {
    stopAutoplay(room);
    io.to(room.code).emit('game:pool-empty');
    return;
  }
  io.to(room.code).emit('game:number-drawn', {
    number: drawn,
    history: room.drawnNumbers,
  });
}

io.on('connection', (socket) => {
  // ---------- HOST ----------
  socket.on('host:create', ({ cardCount, clientId } = {}, cb) => {
    const safeClientId = clientId ? String(clientId).slice(0, 64) : null;
    const room = games.createRoom(socket.id, cardCount, safeClientId);
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    socket.data.clientId = safeClientId;
    cb?.({ ok: true, room: roomPublicState(room) });
  });

  // Reconexión del host tras un refresh: recupera la sala tal cual estaba
  // (números cantados, jugadores, cartones tomados, autoplay) sin resetear nada.
  socket.on('host:rejoin', ({ roomCode, clientId } = {}, cb) => {
    const room = games.getRoom(roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });
    if (!room.reclaimHost(clientId, socket.id)) {
      return cb?.({ ok: false, reason: 'not-host' });
    }
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    socket.data.clientId = clientId;
    cb?.({ ok: true, room: roomPublicState(room) });
  });

  socket.on('host:draw-next', (_payload, cb) => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    room.status = 'playing';
    drawAndBroadcast(io, room);
    cb?.({ ok: true });
  });

  socket.on('host:toggle-autoplay', (_payload, cb) => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });

    if (room.autoplay) {
      stopAutoplay(room);
    } else {
      room.status = 'playing';
      room.autoplay = true;
      room.autoplayTimer = setInterval(() => drawAndBroadcast(io, room), AUTOPLAY_INTERVAL_MS);
      drawAndBroadcast(io, room); // primer número inmediato
    }
    io.to(room.code).emit('room:state', roomPublicState(room));
    cb?.({ ok: true, autoplay: room.autoplay });
  });

  socket.on('host:reset', (_payload, cb) => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return cb?.({ ok: false });
    stopAutoplay(room);
    games.deleteRoom(room.code);
    cb?.({ ok: true });
  });

  // ---------- JUGADOR ----------
  socket.on('player:join', ({ roomCode, name, clientId } = {}, cb) => {
    const room = games.getRoom(roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });

    const safeName = (name || 'Jugador').toString().trim().slice(0, 24) || 'Jugador';
    const safeClientId = clientId ? String(clientId).slice(0, 64) : null;
    room.addPlayer(socket.id, safeName, safeClientId);
    socket.join(room.code);
    socket.data.role = 'player';
    socket.data.roomCode = room.code;
    socket.data.clientId = safeClientId;

    // Todavía no tiene cartón: entrega el catálogo completo para que elija.
    cb?.({
      ok: true,
      roomCode: room.code,
      name: safeName,
      drawnNumbers: room.drawnNumbers,
      cards: room.cardsWithGrids(),
      cardsStatus: room.cardsSummary(),
    });
    io.to(room.code).emit('room:state', roomPublicState(room));
  });

  // Reconexión tras un refresh: el navegador manda su clientId persistente
  // y recupera exactamente donde estaba (cartón, marcas, sala) sin pasar
  // de nuevo por la pantalla de "unirme".
  socket.on('player:rejoin', ({ roomCode, clientId } = {}, cb) => {
    const room = games.getRoom(roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });
    if (!clientId) return cb?.({ ok: false, reason: 'no-client-id' });

    const player = room.reclaimPlayer(clientId, socket.id);
    if (!player) return cb?.({ ok: false, reason: 'no-session' });

    socket.join(room.code);
    socket.data.role = 'player';
    socket.data.roomCode = room.code;
    socket.data.clientId = clientId;

    cb?.({
      ok: true,
      roomCode: room.code,
      name: player.name,
      drawnNumbers: room.drawnNumbers,
      cardId: player.cardId,
      card: player.card,
      marked: Array.from(player.marked),
      cardsStatus: room.cardsSummary(),
      // Si aún no había confirmado cartón, le mandamos el catálogo completo
      // para que siga eligiendo justo donde se quedó.
      cards: player.cardId == null ? room.cardsWithGrids() : undefined,
    });
    io.to(room.code).emit('room:state', roomPublicState(room));
  });

  socket.on('player:confirm-card', ({ cardId } = {}, cb) => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });

    const result = room.claimCard(socket.id, Number(cardId));
    cb?.(result);
    if (result.ok) {
      io.to(room.code).emit('room:state', roomPublicState(room));
    }
  });

  socket.on('player:mark', ({ row, col } = {}, cb) => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });

    const result = room.markCell(socket.id, row, col);
    if (!result.ok) return cb?.(result);

    cb?.({ ok: true, marked: Array.from(result.player.marked) });

    if (result.wins.length > 0) {
      result.wins.forEach((win) => {
        io.to(room.code).emit('game:win', {
          playerId: result.player.id,
          name: result.player.name,
          pattern: win.pattern, // 'terna' | 'linea' | 'carton'
          row: win.row,
        });
      });
    }
    io.to(room.code).emit('room:state', roomPublicState(room));
  });

  // ---------- DESCONEXIÓN ----------
  socket.on('disconnect', () => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room) return;

    if (socket.data.role === 'host' && room.hostSocketId === socket.id) {
      // No cierra la sala de inmediato: le da margen al host para reconectar
      // (por ejemplo, tras un refresh) antes de terminar la partida de verdad.
      room.scheduleHostRemoval(HOST_RECONNECT_GRACE_MS, () => {
        games.deleteRoom(room.code);
        io.to(room.code).emit('room:host-left');
      });
    } else if (socket.data.role === 'player') {
      // No lo saca de inmediato: le da un margen para reconectar (por
      // ejemplo, si solo refrescó la página) antes de liberar su cartón.
      room.scheduleRemoval(socket.id, socket.data.clientId, RECONNECT_GRACE_MS, () => {
        io.to(room.code).emit('room:state', roomPublicState(room));
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Lotería digital corriendo en http://localhost:${PORT}`);
});
