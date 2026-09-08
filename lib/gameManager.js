'use strict';

const { generateUniqueCards } = require('./cardGenerator');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O/0/I/1 para evitar confusión
const MIN_CARDS = 10;
const MAX_CARDS = 200;
const DEFAULT_CARD_COUNT = 90; // igual que los juegos físicos de 90 números

function makeRoomCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

function clampCardCount(n) {
  const value = Number.isFinite(n) ? Math.round(n) : DEFAULT_CARD_COUNT;
  return Math.min(MAX_CARDS, Math.max(MIN_CARDS, value));
}

class Room {
  constructor(code, hostSocketId, cardCount, hostClientId) {
    this.code = code;
    this.hostSocketId = hostSocketId;
    this.hostClientId = hostClientId || null;
    this.pendingHostRemoval = null; // timeout, para el período de gracia del host al refrescar
    this.players = new Map(); // socketId -> player
    this.clientIndex = new Map(); // clientId (persistente en el navegador) -> socketId actual
    this.pendingRemovals = new Map(); // clientId -> timeout, para el período de gracia al refrescar
    this.drawnNumbers = [];
    this.pool = Array.from({ length: 90 }, (_, i) => i + 1);
    this.status = 'lobby'; // lobby | playing | finished
    this.autoplay = false;
    this.autoplayTimer = null;

    // Premios únicos por sala: la primera terna y la primera línea que se
    // logren cierran ese premio para el resto de la partida (nadie más
    // puede volver a ganarlo). El cartón lleno sigue siendo por jugador.
    this.roomWins = { terna: false, linea: false };

    // Set fijo y numerado de cartones, igual que un juego físico (cartón 1, 2, 3...).
    const grids = generateUniqueCards(cardCount);
    this.cards = grids.map((grid, i) => ({
      id: i + 1,
      grid,
      takenBy: null,     // socketId del dueño, o null si está libre
      takenByName: null,
    }));
  }

  addPlayer(socketId, name, clientId) {
    const player = {
      id: socketId,
      clientId,
      name,
      cardId: null,
      card: null, // se asigna recién al confirmar un cartón
      marked: new Set(), // "row-col" de celdas marcadas
      claimed: { terna: new Set(), linea: new Set(), carton: false },
    };
    this.players.set(socketId, player);
    if (clientId) this.clientIndex.set(clientId, socketId);
    return player;
  }

  /**
   * Re-asocia a un jugador ya existente (identificado por su clientId
   * persistente) con un nuevo socketId. Se usa cuando el jugador refresca
   * el navegador: mismo cartón, mismas celdas marcadas, sin perder nada.
   */
  reclaimPlayer(clientId, newSocketId) {
    const oldSocketId = this.clientIndex.get(clientId);
    if (oldSocketId == null) return null;
    const player = this.players.get(oldSocketId);
    if (!player) return null;

    // Cancela el borrado pendiente por desconexión, si existía.
    const pending = this.pendingRemovals.get(clientId);
    if (pending) {
      clearTimeout(pending);
      this.pendingRemovals.delete(clientId);
    }

    this.players.delete(oldSocketId);
    player.id = newSocketId;
    this.players.set(newSocketId, player);
    this.clientIndex.set(clientId, newSocketId);

    // Si ya tenía un cartón confirmado, el "dueño" pasa a ser el socket nuevo.
    if (player.cardId != null) {
      const card = this.cards.find((c) => c.id === player.cardId);
      if (card && card.takenBy === oldSocketId) {
        card.takenBy = newSocketId;
      }
    }
    return player;
  }

  /**
   * Programa la liberación real del jugador tras un período de gracia,
   * para darle tiempo a reconectar (por ejemplo, tras un refresh) sin
   * perder su cartón. Si reconecta antes, reclaimPlayer cancela esto.
   */
  scheduleRemoval(socketId, clientId, delayMs, onExpire) {
    if (!clientId) {
      // Sin clientId no hay forma de reclamar después: se libera de inmediato.
      this.removePlayer(socketId);
      onExpire?.();
      return;
    }
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(clientId);
      this.removePlayer(socketId);
      onExpire?.();
    }, delayMs);
    this.pendingRemovals.set(clientId, timer);
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    // Si tenía un cartón confirmado y se desconecta, lo libera para que otro lo tome.
    if (player?.cardId != null) {
      const card = this.cards.find((c) => c.id === player.cardId);
      if (card && card.takenBy === socketId) {
        card.takenBy = null;
        card.takenByName = null;
      }
    }
    if (player?.clientId) this.clientIndex.delete(player.clientId);
    this.players.delete(socketId);
  }

  /**
   * Re-asocia al host (identificado por su clientId persistente) con un
   * nuevo socketId tras un refresh, sin tocar el estado de la partida.
   */
  reclaimHost(clientId, newSocketId) {
    if (!clientId || this.hostClientId !== clientId) return false;
    if (this.pendingHostRemoval) {
      clearTimeout(this.pendingHostRemoval);
      this.pendingHostRemoval = null;
    }
    this.hostSocketId = newSocketId;
    return true;
  }

  /**
   * Programa el cierre real de la sala tras un período de gracia, para
   * darle tiempo al host a reconectar (por ejemplo, tras un refresh) sin
   * perder la partida. Si reconecta antes, reclaimHost cancela esto.
   */
  scheduleHostRemoval(delayMs, onExpire) {
    if (this.pendingHostRemoval) clearTimeout(this.pendingHostRemoval);
    this.pendingHostRemoval = setTimeout(() => {
      this.pendingHostRemoval = null;
      onExpire?.();
    }, delayMs);
  }

  cardsSummary() {
    return this.cards.map((c) => ({ id: c.id, taken: !!c.takenBy, takenByName: c.takenByName }));
  }

  cardsWithGrids() {
    return this.cards.map((c) => ({ id: c.id, grid: c.grid }));
  }

  /**
   * Intenta asignarle un cartón numerado a un jugador. Falla si ya lo tiene
   * otro jugador, o si este jugador ya había confirmado uno antes.
   */
  claimCard(socketId, cardId) {
    const player = this.players.get(socketId);
    if (!player) return { ok: false, reason: 'no-player' };
    if (player.cardId != null) return { ok: false, reason: 'already-has-card' };

    const card = this.cards.find((c) => c.id === cardId);
    if (!card) return { ok: false, reason: 'not-found' };
    if (card.takenBy && card.takenBy !== socketId) {
      return { ok: false, reason: 'taken', takenByName: card.takenByName };
    }

    card.takenBy = socketId;
    card.takenByName = player.name;
    player.cardId = card.id;
    player.card = card.grid;

    return { ok: true, cardId: card.id, card: card.grid };
  }

  drawNumber() {
    if (this.pool.length === 0) return null;
    const idx = Math.floor(Math.random() * this.pool.length);
    const [number] = this.pool.splice(idx, 1);
    this.drawnNumbers.push(number);
    return number;
  }

  playerSummaries() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      cardId: p.cardId,
      markedCount: p.marked.size,
    }));
  }

  /**
   * Marca una celda para un jugador (si el número ya fue cantado) y
   * devuelve los premios recién obtenidos: [{pattern:'terna'|'linea'|'carton', row}]
   */
  markCell(socketId, row, col) {
    const player = this.players.get(socketId);
    if (!player) return { ok: false, reason: 'no-player' };
    if (!player.card) return { ok: false, reason: 'no-card' };

    const value = player.card[row]?.[col];
    if (value == null) return { ok: false, reason: 'empty-cell' };
    if (!this.drawnNumbers.includes(value)) return { ok: false, reason: 'not-drawn' };

    const key = `${row}-${col}`;
    const wasMarked = player.marked.has(key);
    if (wasMarked) {
      player.marked.delete(key); // permite des-marcar por error de click
    } else {
      player.marked.add(key);
    }

    const wins = [];
    if (!wasMarked) {
      // Revisa la fila afectada
      const rowCells = [0, 1, 2, 3, 4, 5, 6, 7, 8]
        .filter((c) => player.card[row][c] != null);
      const markedInRow = rowCells.filter((c) => player.marked.has(`${row}-${c}`)).length;

      if (markedInRow >= 3 && !this.roomWins.terna && !player.claimed.terna.has(row)) {
        player.claimed.terna.add(row);
        this.roomWins.terna = true;
        wins.push({ pattern: 'terna', row });
      }
      if (markedInRow === rowCells.length && !this.roomWins.linea && !player.claimed.linea.has(row)) {
        player.claimed.linea.add(row);
        this.roomWins.linea = true;
        wins.push({ pattern: 'linea', row });
      }
      const totalCells = player.card.flat().filter((v) => v != null).length;
      if (player.marked.size === totalCells && !player.claimed.carton) {
        player.claimed.carton = true;
        wins.push({ pattern: 'carton', row: null });
      }
    }

    return { ok: true, player, wins };
  }
}

class GameManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(hostSocketId, cardCount, hostClientId) {
    const codes = new Set(this.rooms.keys());
    const code = makeRoomCode(codes);
    const room = new Room(code, hostSocketId, clampCardCount(cardCount), hostClientId);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (room?.autoplayTimer) clearInterval(room.autoplayTimer);
    if (room?.pendingHostRemoval) clearTimeout(room.pendingHostRemoval);
    if (room?.pendingRemovals) {
      room.pendingRemovals.forEach((timer) => clearTimeout(timer));
    }
    this.rooms.delete(code);
  }

  findRoomByHost(hostSocketId) {
    return Array.from(this.rooms.values()).find((r) => r.hostSocketId === hostSocketId);
  }
}

module.exports = { GameManager, DEFAULT_CARD_COUNT, MIN_CARDS, MAX_CARDS };
