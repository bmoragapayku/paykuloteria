# Lotería Digital

Bingo/Lotería de 90 números en tiempo real: una pantalla central (TV o monitor)
canta los números y los jugadores marcan su cartón desde el celular, uniéndose
por QR. Detecta automáticamente **Terna**, **Línea** y **Cartón lleno**.

## Cómo funciona

- **`/host.html`** → se abre en la TV/monitor. Al crear la sala eliges cuántos
  cartones tiene el mazo (24/48/72/90/96/100, igual que los juegos físicos).
  Muestra el QR para que los jugadores se unan, canta los números y avisa
  cuando alguien gana.
- **`/player.html`** → se abre en el celular de cada jugador (al escanear el QR
  ya llega con el código de sala prellenado). Pide el nombre y luego el
  jugador **elige su cartón** de todo el mazo numerado: puede tocar cualquier
  número de cartón para previsualizarlo, usar "🔀 Otro cartón" para que le
  proponga uno al azar entre los libres, y confirma con **Confirmar cartón**
  para dejarlo asignado (ahí recién queda descontado del total disponible).
  Si alguien intenta tomar un cartón que ya está confirmado por otro jugador,
  le sale el aviso "Este cartón ya lo eligió *Nombre* 😛" y no puede tomarlo.
  Una vez confirmado, marca sus números con un click/tap.
- El servidor valida cada marca contra los números realmente sorteados, así que
  no se puede "hacer trampa" marcando números que no han salido. Lo mismo con
  los cartones: la asignación se resuelve en el servidor, así que dos jugadores
  nunca pueden terminar con el mismo cartón aunque hagan click casi al mismo tiempo.
- Si un jugador se desconecta antes de confirmar cartón no pasa nada; si se
  desconecta después de haberlo confirmado, ese cartón vuelve a quedar libre
  para que otro lo tome.

## Instalación

Necesitas [Node.js](https://nodejs.org) 18 o superior instalado.

```bash
npm install
npm start
```

Esto levanta el servidor en `http://localhost:3000`.

## Cómo jugar en un evento (TV + celulares en la misma red)

1. Conecta el computador que hace de servidor y la Smart TV/monitor a la
   **misma red Wi-Fi** que los celulares de los jugadores.
2. Averigua la IP local del servidor (ej. `192.168.1.20`):
   - Mac/Linux: `ifconfig` o `ipconfig getifaddr en0`
   - Windows: `ipconfig`
3. En la TV/monitor, abre `http://<IP-DEL-SERVIDOR>:3000/host.html` y haz clic
   en **Crear sala**. Aparece el código de sala y el QR.
4. Los jugadores escanean el QR con la cámara del celular (deben estar
   conectados al mismo Wi-Fi) y llegan directo a `player.html` con la sala
   ya cargada. Ingresan su nombre y quedan con su cartón listo.
5. Desde la TV: **Cantar número** saca un número a la vez (a tu ritmo), o
   activa **Autoplay** para que salga uno automáticamente cada 6 segundos.
6. Cuando un jugador marca 3 números en una fila, se completa una fila
   entera, o completa las 15 casillas de su cartón, la TV muestra una
   alerta grande con su nombre y el premio ganado.

## Desplegarlo para jugar por internet (no solo red local)

Si quieres que los jugadores se unan desde afuera de tu red (no solo
Wi-Fi local), sube este proyecto a un servicio que soporte WebSockets,
por ejemplo:

- **Railway** (`railway.app`) o **Render** (`render.com`): conectas el
  repo de GitHub, seleccionan Node.js, y listo — quedan con una URL
  pública tipo `https://tu-loteria.up.railway.app`.
- Ahí mismo puedes usar tu dominio de Voltea si prefieres (ej.
  `loteria.voltea.cl`) apuntando con un CNAME al servicio elegido.

## Personalización rápida

- **Colores/estilo**: todo el diseño está en variables CSS (`:root`) al
  inicio de `public/host.html` y `public/player.html` — fácil de ajustar
  a la marca de un cliente puntual sin tocar la lógica del juego.
- **Velocidad del autoplay**: constante `AUTOPLAY_INTERVAL_MS` en
  `server.js` (por defecto 6000 ms).
- **Cantidad de cartones**: se elige en el lobby de `host.html` (el
  `<select>` con id `cardCountSelect`); agrega o quita opciones ahí. El
  límite técnico (10 a 200 cartones) está en `MIN_CARDS`/`MAX_CARDS` en
  `lib/gameManager.js`.
- **Reglas de premio**: la lógica de Terna/Línea/Cartón está en
  `lib/gameManager.js`, en el método `markCell`. Se puede agregar
  fácilmente un patrón nuevo (ej. "las 4 esquinas") ahí mismo.

## Estructura del proyecto

```
loteria-digital/
├── server.js              # servidor Express + Socket.io
├── lib/
│   ├── cardGenerator.js   # genera cartones válidos de 90 números
│   └── gameManager.js     # estado de salas, sorteo y detección de premios
├── public/
│   ├── host.html          # pantalla central / TV
│   └── player.html        # vista del jugador (celular)
└── package.json
```

## Próximos pasos posibles (no incluidos todavía)

- Sonido al cantar el número y al ganar (fácil de agregar con la Web Audio API).
- Múltiples cartones por jugador.
- Panel de administrador para elegir manualmente qué patrones cuentan como premio.
- Persistencia en base de datos si quieres historial de partidas entre reinicios del servidor (hoy vive en memoria).
