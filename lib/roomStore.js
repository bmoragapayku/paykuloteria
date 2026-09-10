'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let client = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.warn(
    'SUPABASE_URL / SUPABASE_KEY no están configuradas: las salas NO sobrevivirán ' +
      'a un reinicio del servidor (solo quedan en memoria).'
  );
}

const TABLE = 'rooms';

/** Guarda (o actualiza) el snapshot completo de una sala. */
async function saveRoom(code, snapshot) {
  if (!client) return;
  const { error } = await client
    .from(TABLE)
    .upsert({ code, data: snapshot, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

/** Borra la fila de una sala (cuando el host la reinicia o expira). */
async function deleteRoom(code) {
  if (!client) return;
  const { error } = await client.from(TABLE).delete().eq('code', code);
  if (error) throw new Error(error.message);
}

/** Carga todas las salas guardadas — se llama una sola vez, al arrancar el servidor. */
async function loadAllRooms() {
  if (!client) return {};
  const { data, error } = await client.from(TABLE).select('code, data');
  if (error) throw new Error(error.message);
  const snapshot = {};
  (data || []).forEach((row) => {
    snapshot[row.code] = row.data;
  });
  return snapshot;
}

module.exports = { saveRoom, deleteRoom, loadAllRooms };
