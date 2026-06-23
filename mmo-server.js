const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ══════════════════════════════════════════════════════════════════════
//  WORLD GENERATION
//  Die Welt wird einmalig beim Server-Start generiert und im RAM gehalten.
//  Bei einem Neustart des Servers wird eine neue Welt generiert.
// ══════════════════════════════════════════════════════════════════════

const WORLD_SIZE   = 200;   // Weltgröße in Einheiten
const CHUNK_SIZE   = 20;    // Chunk-Größe
const TREE_COUNT   = 120;   // Anzahl Bäume
const ROCK_COUNT   = 60;    // Anzahl Felsen
const SEED         = 42;    // Zufalls-Seed für deterministische Welt

// Einfacher deterministischer Zufallsgenerator (kein Math.random → gleiche Welt immer)
function seededRandom(seed) {
    let s = seed;
    return function() {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
    };
}

// Simplex-ähnliche Höhenmap via mehrere Sinus-Wellen
function getHeight(x, z) {
    return (
        Math.sin(x * 0.05) * 3 +
        Math.sin(z * 0.07) * 2 +
        Math.sin(x * 0.02 + z * 0.03) * 5 +
        Math.cos(x * 0.08 - z * 0.04) * 2 +
        Math.sin((x + z) * 0.015) * 8
    );
}

function generateWorld() {
    const rng = seededRandom(SEED);
    const world = {
        seed: SEED,
        size: WORLD_SIZE,
        chunkSize: CHUNK_SIZE,
        spawnPoint: { x: 0, y: 0, z: 0 },
        objects: [],
        generatedAt: Date.now()
    };

    // Spawn-Punkt Höhe berechnen
    world.spawnPoint.y = getHeight(0, 0) + 1;

    // Bäume generieren
    for (let i = 0; i < TREE_COUNT; i++) {
        const x = (rng() - 0.5) * WORLD_SIZE * 0.9;
        const z = (rng() - 0.5) * WORLD_SIZE * 0.9;
        const y = getHeight(x, z);
        const scale = 0.8 + rng() * 0.8;
        const variant = Math.floor(rng() * 3); // 3 Baumtypen
        world.objects.push({ type: "tree", x, y, z, scale, variant, id: `tree_${i}` });
    }

    // Felsen generieren
    for (let i = 0; i < ROCK_COUNT; i++) {
        const x = (rng() - 0.5) * WORLD_SIZE * 0.9;
        const z = (rng() - 0.5) * WORLD_SIZE * 0.9;
        const y = getHeight(x, z);
        const scale = 0.3 + rng() * 0.7;
        world.objects.push({ type: "rock", x, y, z, scale, id: `rock_${i}` });
    }

    console.log(`[WORLD] Generiert: ${world.objects.length} Objekte, Größe ${WORLD_SIZE}x${WORLD_SIZE}`);
    return world;
}

// Höhenmap-Funktion (für Spieler-Positionsvalidierung)
function getTerrainHeight(x, z) {
    return getHeight(x, z);
}

// ── Welt-State (nur im RAM) ────────────────────────────────────────────
let WORLD = generateWorld();
console.log(`[WORLD] Welt bereit (generiert: ${new Date(WORLD.generatedAt).toLocaleString()})`);

// ══════════════════════════════════════════════════════════════════════
//  PLAYER MANAGEMENT
// ══════════════════════════════════════════════════════════════════════

// Aktive Spieler im RAM: { playerId → { ws, data } }
const players = new Map();

// Einzigartiger Spieler-ID Generator
let playerIdCounter = 1;
function genPlayerId() {
    return `p${Date.now()}_${playerIdCounter++}`;
}

// Zufällige Farbe für Spieler-Charakter
const PLAYER_COLORS = ["#ff4444","#44aaff","#44ff88","#ffaa44","#ff44ff","#44ffff","#ffff44","#ff8844"];
function randomColor() {
    return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

// Alle Spieler-Daten (ohne WebSocket) für Broadcasts
function getPlayersData() {
    const result = {};
    for (const [id, { data }] of players.entries()) {
        result[id] = data;
    }
    return result;
}

// Nachricht an alle außer Absender
function broadcast(message, excludeId = null) {
    const msg = JSON.stringify(message);
    for (const [id, { ws }] of players.entries()) {
        if (id !== excludeId && ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    }
}

// Nachricht an alle inkl. Absender
function broadcastAll(message) {
    const msg = JSON.stringify(message);
    for (const { ws } of players.values()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    }
}

// ══════════════════════════════════════════════════════════════════════
//  WEBSOCKET HANDLER
// ══════════════════════════════════════════════════════════════════════

wss.on("connection", (ws) => {
    const playerId = genPlayerId();
    const spawnY = getTerrainHeight(0, 0) + 1.5;

    const playerData = {
        id: playerId,
        name: "Spieler",
        x: (Math.random() - 0.5) * 10,  // Leicht versetzt spawnen
        y: spawnY,
        z: (Math.random() - 0.5) * 10,
        rotY: 0,
        color: randomColor(),
        moving: false,
        hp: 100,
        joinedAt: Date.now()
    };

    players.set(playerId, { ws, data: playerData });
    console.log(`[JOIN] ${playerId} verbunden | Spieler gesamt: ${players.size}`);

    // 1. Begrüßung: eigene ID + Welt + alle Spieler
    ws.send(JSON.stringify({
        type: "init",
        playerId,
        world: WORLD,
        players: getPlayersData()
    }));

    // 2. Alle anderen über neuen Spieler informieren
    broadcast({
        type: "player_join",
        player: playerData
    }, playerId);

    // ── Nachrichten vom Client ─────────────────────────────────────────
    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            // Spieler sendet Name beim ersten Connect
            case "set_name": {
                const name = String(msg.name || "").slice(0, 20).trim() || "Spieler";
                playerData.name = name;
                broadcast({ type: "player_update", player: playerData }, playerId);
                break;
            }

            // Spieler sendet Position (kommt ~20x pro Sekunde)
            case "move": {
                // Validierung: Spieler darf nicht teleportieren (großzügig für Latenz)
                const dx = Math.abs(msg.x - playerData.x);
                const dz = Math.abs(msg.z - playerData.z);
                if (dx > 20 || dz > 20) break; // Cheat-Schutz (Teleport)

                playerData.x = msg.x;
                playerData.y = msg.y ?? getTerrainHeight(msg.x, msg.z) + 1.5;
                playerData.z = msg.z;
                playerData.rotY = msg.rotY ?? 0;
                playerData.moving = msg.moving ?? false;

                // An alle anderen Spieler weiterleiten
                broadcast({
                    type: "player_move",
                    id: playerId,
                    x: playerData.x,
                    y: playerData.y,
                    z: playerData.z,
                    rotY: playerData.rotY,
                    moving: playerData.moving,
                    t: Date.now()
                }, playerId);
                break;
            }

            // Chat-Nachricht
            case "chat": {
                const text = String(msg.text || "").slice(0, 200).trim();
                if (!text) break;
                console.log(`[CHAT] ${playerData.name}: ${text}`);
                broadcastAll({
                    type: "chat",
                    id: playerId,
                    name: playerData.name,
                    text,
                    color: playerData.color
                });
                break;
            }

            // Spell cast – relay to all other players
            case "spell_cast": {
                broadcast({
                    type: "spell_cast",
                    from: playerId,
                    spell: msg.spell,
                    ox: msg.ox, oy: msg.oy, oz: msg.oz,
                    dx: msg.dx, dy: msg.dy, dz: msg.dz
                }, playerId);
                break;
            }

            // Hit – server validates and applies damage
            case "hit": {
                const target = players.get(msg.targetId);
                if (!target) break;
                if (target.data.hp <= 0) break; // already dead

                const SPELL_DAMAGE = [25, 15, 45, 8];
                const damage = SPELL_DAMAGE[msg.spell] ?? 10;

                target.data.hp = Math.max(0, target.data.hp - damage);

                // Notify everyone about the hit
                broadcastAll({
                    type: "player_hit",
                    targetId: msg.targetId,
                    attackerId: playerId,
                    attackerName: playerData.name,
                    damage,
                    hp: target.data.hp
                });

                console.log(`[HIT] ${playerData.name} → ${target.data.name}: -${damage}hp (${target.data.hp} left)`);

                // Death
                if (target.data.hp <= 0) {
                    console.log(`[DEATH] ${target.data.name} killed by ${playerData.name}`);
                    broadcastAll({
                        type: "player_died",
                        id: msg.targetId,
                        victimName: target.data.name,
                        killerName: playerData.name
                    });
                }
                break;
            }

            // Respawn
            case "respawn": {
                playerData.hp = 100;
                playerData.x = msg.x ?? 0;
                playerData.y = msg.y ?? 5;
                playerData.z = msg.z ?? 0;

                broadcastAll({
                    type: "player_respawned",
                    id: playerId,
                    x: playerData.x,
                    y: playerData.y,
                    z: playerData.z
                });
                console.log(`[RESPAWN] ${playerData.name}`);
                break;
            }

            // Ping (keep-alive)
            case "ping": {
                ws.send(JSON.stringify({ type: "pong", t: msg.t }));
                break;
            }
        }
    });

    // ── Disconnect ─────────────────────────────────────────────────────
    ws.on("close", () => {
        players.delete(playerId);
        console.log(`[LEAVE] ${playerId} getrennt | Spieler gesamt: ${players.size}`);
        broadcastAll({ type: "player_leave", id: playerId });
    });

    ws.on("error", (err) => {
        console.error(`[ERROR] ${playerId}:`, err.message);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  REST ENDPOINTS
// ══════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
    res.json({
        status: "ok",
        players: players.size,
        world: {
            size: WORLD.size,
            objects: WORLD.objects.length,
            generatedAt: WORLD.generatedAt
        }
    });
});

// Welt-Daten abrufen (für Clients die HTTP bevorzugen)
app.get("/world", (req, res) => {
    res.json(WORLD);
});

// Spielerliste
app.get("/players", (req, res) => {
    res.json({
        count: players.size,
        players: getPlayersData()
    });
});

// Welt zurücksetzen (nur für Admin)
app.post("/reset-world", (req, res) => {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: "Nicht autorisiert" });
    }
    WORLD = generateWorld();
    broadcastAll({ type: "world_reset", world: WORLD });
    console.log("[WORLD] Welt manuell zurückgesetzt");
    res.json({ success: true, message: "Welt neu generiert" });
});

// ══════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`MMO Server läuft auf Port ${PORT}`);
    console.log(`[READY] Server bereit für Verbindungen`);
});
