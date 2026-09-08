'use strict';

// Rangos de cada columna del cartón clásico de 90 números.
// Columna 0: 1-9, columna 1: 10-19, ... columna 8: 80-90
const COLUMN_RANGES = [
  [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
  [50, 59], [60, 69], [70, 79], [80, 90],
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sampleUnique(pool, count) {
  return shuffle(pool).slice(0, count);
}

function rangeArray(min, max) {
  const out = [];
  for (let n = min; n <= max; n++) out.push(n);
  return out;
}

/**
 * Decide qué celdas de la grilla 3x9 tienen número.
 * Regla: cada fila tiene exactamente 5 números, cada columna tiene
 * entre 1 y 3 números en todo el cartón (igual que un cartón real).
 */
function buildLayout() {
  let layout;
  let attempts = 0;
  do {
    attempts++;
    const grid = Array.from({ length: 3 }, () => Array(9).fill(false));
    for (let row = 0; row < 3; row++) {
      const cols = shuffle([...Array(9).keys()]).slice(0, 5);
      cols.forEach((c) => { grid[row][c] = true; });
    }
    const colCounts = Array(9).fill(0);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) {
        if (grid[row][col]) colCounts[col]++;
      }
    }
    const valid = colCounts.every((c) => c >= 1 && c <= 3);
    if (valid || attempts > 2000) {
      layout = grid;
      break;
    }
  } while (true);
  return layout;
}

/**
 * Genera un cartón: matriz 3x9, cada celda es un número o null (celda vacía/roja).
 */
function generateCard() {
  const layout = buildLayout();
  const card = Array.from({ length: 3 }, () => Array(9).fill(null));

  for (let col = 0; col < 9; col++) {
    const [min, max] = COLUMN_RANGES[col];
    const rowsWithNumber = [0, 1, 2].filter((row) => layout[row][col]);
    const picked = sampleUnique(rangeArray(min, max), rowsWithNumber.length)
      .sort((a, b) => a - b);
    rowsWithNumber.forEach((row, idx) => {
      card[row][col] = picked[idx];
    });
  }

  return card;
}

/**
 * Genera `count` cartones únicos entre sí (sin cartones idénticos en la misma sala).
 */
function generateUniqueCards(count) {
  const cards = [];
  const seen = new Set();
  let guard = 0;
  while (cards.length < count && guard < count * 50 + 100) {
    guard++;
    const card = generateCard();
    const key = JSON.stringify(card);
    if (!seen.has(key)) {
      seen.add(key);
      cards.push(card);
    }
  }
  return cards;
}

module.exports = { generateCard, generateUniqueCards, COLUMN_RANGES };
