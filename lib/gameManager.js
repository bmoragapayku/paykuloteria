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

/**
 * IMPORTANTE: la identidad de host y jugadores se guarda por su `clientId`
 * (un id persistente que el navegador genera una vez y guarda en
 * localStorage) — NUNCA por `socket.id`. El socket.id cambia cada vez que
 * alguien se reconecta (refresh, corte de wifi, o un reinicio del propio
 * servidor), así que no sirve como llave estable. `socketId` solo se guarda
 * como un dato de "a dónde mandarle mensajes ahora mismo", no como identidad.
 */
class Room {
  constructor(code, hostClientId, cards) {
    this.code = code;
    this.hostClientId = hostClientId || null;
    this.hostSocketId = null; // se completa recién cuando el host conecta de verdad
    this.pendingHostRemoval = null; // timeout, período de gracia del host al desconectarse

    this.players = new Map(); // clientId -> player
    this.pendingRemovals = new Map(); // clientId -> timeout, período de gracia del jugador

    this.drawnNumbers = [];
    this.pool = Array.from({ length: 90 }, (_, i) => i + 1);
    this.status = 'lobby'; // lobby | playing | finished
    this.autoplay = false;
    this.autoplayTimer = null;

    // Premios únicos por sala: la primera terna y la primera línea que se
    // logren cierran ese premio para el resto de la partida (nadie más
    // puede volver a ganarlo). El cartón lleno sigue siendo por jugador.
    this.roomWins = { terna: false, linea: false };

    this.cards = cards; // [{ id, grid, takenByClientId, takenByName }]
  }

  /** Crea una sala nueva generando un mazo de cartones desde cero. */
  static create(code, hostClientId, cardCount) {
    const grids = generateUniqueCards(clampCardCount(cardCount));
    const cards = grids.map((grid, i) => ({
      id: i + 1,
      grid,
      takenByClientId: null,
      takenByName: null,
    }));
    return new Room(code, hostClientId, cards);
  }

  /** Reconstruye una sala ya existente a partir de un snapshot guardado en disco. */
  static fromSnapshot(data) {
    const room = new Room(data.code, data.hostClientId, data.cards);
    room.status = data.status || 'lobby';
    room.drawnNumbers = data.drawnNumbers || [];
    room.pool = data.pool || [];
    room.roomWins = data.roomWins || { terna: false, linea: false };
    (data.players || []).forEach((pd) => {
      const player = {
        clientId: pd.clientId,
        name: pd.name,
        cardId: pd.cardId,
        card: pd.card,
        marked: new Set(pd.marked || []),
        claimed: {
          terna: new Set(pd.claimed?.terna || []),
          linea: new Set(pd.claimed?.linea || []),
          carton: !!pd.claimed?.carton,
        },
        socketId: null, // nadie está conectado todavía justo después de recargar
      };
      room.players.set(player.clientId, player);
    });
    // autoplay y los timers de gracia nunca se recuperan del disco a propósito:
    // tras un reinicio del servidor es más seguro que el host deba
    // reactivar el autoplay él mismo, en vez de que arranque solo en silencio.
    return room;
  }

  /** Snapshot plano (serializable con JSON.stringify) de todo lo que importa persistir. */
  toSnapshot() {
    return {
      code: this.code,
      hostClientId: this.hostClientId,
      status: this.status,
      drawnNumbers: this.drawnNumbers,
      pool: this.pool,
      roomWins: this.roomWins,
      cards: this.cards.map((c) => ({
        id: c.id,
        grid: c.grid,
        takenByClientId: c.takenByClientId,
        takenByName: c.takenByName,
      })),
      players: Array.from(this.players.values()).map((p) => ({
        clientId: p.clientId,
        name: p.name,
        cardId: p.cardId,
        card: p.card,
        marked: Array.from(p.marked),
        claimed: {
          terna: Array.from(p.claimed.terna),
          linea: Array.from(p.claimed.linea),
          carton: p.claimed.carton,
        },
      })),
    };
  }

  addPlayer(clientId, name) {
    const player = {
      clientId,
      name,
      cardId: null,
      card: null, // se asigna recién al confirmar un cartón
      marked: new Set(), // "row-col" de celdas marcadas
      claimed: { terna: new Set(), linea: new Set(), carton: false },
      socketId: null,
    };
    this.players.set(clientId, player);
    return player;
  }

  /**
   * Conecta (o re-conecta) el socket en vivo de un jugador ya existente,
   * identificado por su clientId. Se usa tanto para un refresh normal como
   * para cuando el servidor se reinició y el jugador vuelve a entrar.
   */
  attachPlayerSocket(clientId, socketId) {
    const player = this.players.get(clientId);
    if (!player) return null;
    player.socketId = socketId;

    const pending = this.pendingRemovals.get(clientId);
    if (pending) {
      clearTimeout(pending);
      this.pendingRemovals.delete(clientId);
    }
    return player;
  }

  /**
   * Programa la liberación real del jugador tras un período de gracia,
   * para darle tiempo a reconectar (refresh, corte de wifi, reinicio del
   * servidor) sin perder su cartón. Si reconecta antes, attachPlayerSocket
   * cancela esto.
   */
  scheduleRemoval(clientId, delayMs, onExpire) {
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(clientId);
      this.removePlayer(clientId);
      onExpire?.();
    }, delayMs);
    this.pendingRemovals.set(clientId, timer);
  }

  removePlayer(clientId) {
    const player = this.players.get(clientId);
    // Si tenía un cartón confirmado y se desconecta, lo libera para que otro lo tome.
    if (player?.cardId != null) {
      const card = this.cards.find((c) => c.id === player.cardId);
      if (card && card.takenByClientId === clientId) {
        card.takenByClientId = null;
        card.takenByName = null;
      }
    }
    this.players.delete(clientId);
  }

  /**
   * Conecta (o re-conecta) el socket en vivo del host, identificado por su
   * clientId. Devuelve false si el clientId no coincide con el dueño real
   * de la sala.
   */
  attachHostSocket(clientId, socketId) {
    if (!clientId || this.hostClientId !== clientId) return false;
    this.hostSocketId = socketId;
    if (this.pendingHostRemoval) {
      clearTimeout(this.pendingHostRemoval);
      this.pendingHostRemoval = null;
    }
    return true;
  }

  /**
   * Programa el cierre real de la sala tras un período de gracia, para
   * darle tiempo al host a reconectar sin perder la partida.
   */
  scheduleHostRemoval(delayMs, onExpire) {
    if (this.pendingHostRemoval) clearTimeout(this.pendingHostRemoval);
    this.pendingHostRemoval = setTimeout(() => {
      this.pendingHostRemoval = null;
      onExpire?.();
    }, delayMs);
  }

  cardsSummary() {
    return this.cards.map((c) => ({ id: c.id, taken: !!c.takenByClientId, takenByName: c.takenByName }));
  }

  cardsWithGrids() {
    return this.cards.map((c) => ({ id: c.id, grid: c.grid }));
  }

  /**
   * Intenta asignarle un cartón numerado a un jugador. Falla si ya lo tiene
   * otro jugador, o si este jugador ya había confirmado uno antes.
   */
  claimCard(clientId, cardId) {
    const player = this.players.get(clientId);
    if (!player) return { ok: false, reason: 'no-player' };
    if (player.cardId != null) return { ok: false, reason: 'already-has-card' };

    const card = this.cards.find((c) => c.id === cardId);
    if (!card) return { ok: false, reason: 'not-found' };
    if (card.takenByClientId && card.takenByClientId !== clientId) {
      return { ok: false, reason: 'taken', takenByName: card.takenByName };
    }

    card.takenByClientId = clientId;
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
      id: p.clientId,
      name: p.name,
      cardId: p.cardId,
      markedCount: p.marked.size,
      connected: p.socketId != null,
    }));
  }

  /**
   * Marca una celda para un jugador (si el número ya fue cantado) y
   * devuelve los premios recién obtenidos: [{pattern:'terna'|'linea'|'carton', row}]
   */
  markCell(clientId, row, col) {
    const player = this.players.get(clientId);
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
  /**
   * @param {object|null} store Adaptador de persistencia con
   *   {saveRoom, deleteRoom, loadAllRooms} (ver lib/roomStore.js). Si sus
   *   funciones son no-ops (por falta de configuración), todo funciona
   *   igual, solo que en memoria pura — como antes.
   */
  constructor(store) {
    this.rooms = new Map();
    this.store = store || null;
    this._dirty = new Set(); // códigos de sala pendientes de guardar
    this._saveTimer = null;
  }

  createRoom(hostClientId, cardCount) {
    const codes = new Set(this.rooms.keys());
    const code = makeRoomCode(codes);
    const room = Room.create(code, hostClientId, cardCount);
    this.rooms.set(code, room);
    this.markDirty(code);
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
    this._dirty.delete(code);
    if (this.store) {
      this.store
        .deleteRoom(code)
        .catch((err) => console.error(`No se pudo borrar la sala ${code} guardada:`, err.message));
    }
  }

  findRoomByHost(hostSocketId) {
    return Array.from(this.rooms.values()).find((r) => r.hostSocketId === hostSocketId);
  }

  /** Marca una sala para guardarse pronto (debounce: junta varios cambios seguidos en un solo guardado). */
  markDirty(code) {
    if (!this.store) return;
    this._dirty.add(code);
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 400);
  }

  async flush() {
    const codes = Array.from(this._dirty);
    this._dirty.clear();
    for (const code of codes) {
      const room = this.rooms.get(code);
      if (!room) continue; // se pudo haber borrado justo mientras esperaba
      try {
        await this.store.saveRoom(code, room.toSnapshot());
      } catch (err) {
        console.error(`No se pudo guardar la sala ${code}:`, err.message);
      }
    }
  }

  /** Se llama una sola vez al arrancar el servidor, para recuperar salas de un reinicio anterior. */
  async loadFromStore() {
    if (!this.store) return;
    try {
      const snapshot = await this.store.loadAllRooms();
      Object.entries(snapshot).forEach(([code, data]) => {
        this.rooms.set(code, Room.fromSnapshot(data));
      });
      if (this.rooms.size > 0) {
        console.log(`Recuperadas ${this.rooms.size} sala(s) tras el reinicio.`);
      }
    } catch (err) {
      console.error('No se pudo cargar el estado de las salas:', err.message);
    }
  }
}

module.exports = { GameManager, Room, DEFAULT_CARD_COUNT, MIN_CARDS, MAX_CARDS };
