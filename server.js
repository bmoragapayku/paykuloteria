'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GameManager } = require('./lib/gameManager');
const roomStore = require('./lib/roomStore');

const PORT = process.env.PORT || 3000;
const AUTOPLAY_INTERVAL_MS = 6000;
// El cartón de un jugador (y la sala misma) NUNCA se libera solo por
// desconexión, sin importar cuánto tiempo pase — refresh, WiFi que
// titubea, el celular que se bloquea o se apaga. La única forma de que un
// cartón vuelva a estar disponible es que el host apriete "Reiniciar sala".

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const games = new GameManager(roomStore);

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
  games.markDirty(room.code);
}

io.on('connection', (socket) => {
  // ---------- HOST ----------
  socket.on('host:create', ({ cardCount, clientId } = {}, cb) => {
    const safeClientId = clientId ? String(clientId).slice(0, 64) : null;
    if (!safeClientId) return cb?.({ ok: false, reason: 'no-client-id' });

    const room = games.createRoom(safeClientId, cardCount);
    room.attachHostSocket(safeClientId, socket.id);
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    socket.data.clientId = safeClientId;
    cb?.({ ok: true, room: roomPublicState(room) });
  });

  // Reconexión del host: tras un refresh, un corte de wifi, o incluso un
  // reinicio del servidor (la sala se recupera desde disco), vuelve tal
  // cual estaba — números cantados, jugadores, cartones tomados, autoplay.
  socket.on('host:rejoin', ({ roomCode, clientId } = {}, cb) => {
    const room = games.getRoom(roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });
    if (!room.attachHostSocket(clientId, socket.id)) {
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

    const safeClientId = clientId ? String(clientId).slice(0, 64) : null;
    if (!safeClientId) return cb?.({ ok: false, reason: 'no-client-id' });

    const safeName = (name || 'Jugador').toString().trim().slice(0, 24) || 'Jugador';
    room.addPlayer(safeClientId, safeName);
    room.attachPlayerSocket(safeClientId, socket.id);
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
    games.markDirty(room.code);
  });

  // Reconexión tras un refresh, un corte de wifi, o un reinicio del
  // servidor: el navegador manda su clientId persistente y recupera
  // exactamente donde estaba (cartón, marcas, sala) sin pasar de nuevo por
  // la pantalla de "unirme".
  socket.on('player:rejoin', ({ roomCode, clientId } = {}, cb) => {
    const room = games.getRoom(roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });
    if (!clientId) return cb?.({ ok: false, reason: 'no-client-id' });

    const player = room.attachPlayerSocket(clientId, socket.id);
    if (!player) return cb?.({ ok: false, reason: 'no-session' });

    // Si ya tenía cartón, marca solo los números que salieron mientras
    // estaba desconectado — así no tiene que re-marcarlos uno por uno.
    const autoMark = player.cardId != null
      ? room.autoMarkDrawnNumbers(clientId)
      : { wins: [] };

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
      marked: Array.from(player.marked), // ya incluye lo que se acaba de auto-marcar
      cardsStatus: room.cardsSummary(),
      // Si aún no había confirmado cartón, le mandamos el catálogo completo
      // para que siga eligiendo justo donde se quedó.
      cards: player.cardId == null ? room.cardsWithGrids() : undefined,
    });

    if (autoMark.wins.length > 0) {
      autoMark.wins.forEach((win) => {
        io.to(room.code).emit('game:win', {
          playerId: player.clientId,
          name: player.name,
          pattern: win.pattern,
          row: win.row,
        });
      });
      games.markDirty(room.code);
    }
    io.to(room.code).emit('room:state', roomPublicState(room));
  });

  socket.on('player:confirm-card', ({ cardId } = {}, cb) => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });

    const result = room.claimCard(socket.data.clientId, Number(cardId));
    cb?.(result);
    if (result.ok) {
      io.to(room.code).emit('room:state', roomPublicState(room));
      games.markDirty(room.code);
    }
  });

  socket.on('player:mark', ({ row, col } = {}, cb) => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, reason: 'room-not-found' });

    const result = room.markCell(socket.data.clientId, row, col);
    if (!result.ok) return cb?.(result);

    cb?.({ ok: true, marked: Array.from(result.player.marked) });

    if (result.wins.length > 0) {
      result.wins.forEach((win) => {
        io.to(room.code).emit('game:win', {
          playerId: result.player.clientId,
          name: result.player.name,
          pattern: win.pattern, // 'terna' | 'linea' | 'carton'
          row: win.row,
        });
      });
    }
    io.to(room.code).emit('room:state', roomPublicState(room));
    games.markDirty(room.code);
  });

  // ---------- DESCONEXIÓN ----------
  socket.on('disconnect', () => {
    const room = games.getRoom(socket.data.roomCode);
    if (!room) return;

    if (socket.data.role === 'host' && room.hostSocketId === socket.id) {
      // No cierra la sala: solo la marca como "host desconectado". La
      // partida sigue viva y el host puede volver en cualquier momento.
      room.markHostDisconnected(socket.id);
      io.to(room.code).emit('room:state', roomPublicState(room));
    } else if (socket.data.role === 'player' && socket.data.clientId) {
      // No le suelta el cartón: solo lo marca como desconectado para que
      // el host vea su estado. Puede volver cuando quiera con el mismo
      // cartón y las mismas marcas, sin límite de tiempo.
      room.markPlayerDisconnected(socket.data.clientId, socket.id);
      io.to(room.code).emit('room:state', roomPublicState(room));
    }
  });
});

async function start() {
  await games.loadFromStore();
  server.listen(PORT, () => {
    console.log(`Lotería digital corriendo en http://localhost:${PORT}`);
  });
}

start();
