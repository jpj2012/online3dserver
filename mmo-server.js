const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Supabase ───────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "https://paezlzjonablaseodpze.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "YOUR_ANON_KEY";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ══════════════════════════════════════════════════════════════════════
//  WORLD GENERATION
//  Die Welt wird einmalig generiert und in Supabase gespeichert.
//  Beim Server-Start wird sie geladen – oder neu generiert falls keine existiert.
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

// Höhenmap-Funktion exportieren (für Spieler-Positionsvalidierung)
function getTerrainHeight(x, z) {
    return getHeight(x, z);
}

// ── Welt-State (im RAM, aus Supabase geladen) ──────────────────────────
let WORLD = null;

async function loadOrCreateWorld() {
    try {
        const { data, error } = await supabase
            .from("mmo_world")
            .select("*")
            .eq("id", 1)
            .single();

        if (data && !error) {
            WORLD = data.world_data;
            console.log(`[WORLD] Aus Supabase geladen (generiert: ${new Date(WORLD.generatedAt).toLocaleString()})`);
        } else {
            throw new Error("Keine Welt in Supabase");
        }
    } catch (e) {
        console.log("[WORLD] Generiere neue Welt...");
        WORLD = generateWorld();
        // In Supabase speichern
        await supabase.from("mmo_world").upsert({
            id: 1,
            world_data: WORLD,
            updated_at: new Date().toISOString()
        });
        console.log("[WORLD] Neue Welt in Supabase gespeichert");
    }
}

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
    const spawnY = WORLD ? getTerrainHeight(0, 0) + 1.5 : 1.5;

    const playerData = {
        id: playerId,
        name: "Spieler",
        x: (Math.random() - 0.5) * 10,  // Leicht versetzt spawnen
        y: spawnY,
        z: (Math.random() - 0.5) * 10,
        rotY: 0,
        color: randomColor(),
        moving: false,
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
        world: WORLD ? {
            size: WORLD.size,
            objects: WORLD.objects.length,
            generatedAt: WORLD.generatedAt
        } : "wird geladen..."
    });
});

// Welt-Daten abrufen (für Clients die HTTP bevorzugen)
app.get("/world", (req, res) => {
    if (!WORLD) return res.status(503).json({ error: "Welt wird noch generiert" });
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
app.post("/reset-world", async (req, res) => {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: "Nicht autorisiert" });
    }
    WORLD = generateWorld();
    await supabase.from("mmo_world").upsert({
        id: 1,
        world_data: WORLD,
        updated_at: new Date().toISOString()
    });
    broadcastAll({ type: "world_reset", world: WORLD });
    res.json({ success: true, message: "Welt neu generiert" });
});

// ══════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`MMO Server läuft auf Port ${PORT}`);
    await loadOrCreateWorld();
    console.log(`[READY] Server bereit für Verbindungen`);
});

// Spieler-Positionen alle 30 Sekunden in Supabase speichern
setInterval(async () => {
    if (players.size === 0) return;
    const snapshot = Array.from(players.values()).map(({ data }) => ({
        id: data.id,
        name: data.name,
        x: data.x, y: data.y, z: data.z,
        color: data.color,
        lastSeen: Date.now()
    }));
    try {
        const { error } = await supabase.from("mmo_players_log").upsert(
            snapshot.map(p => ({ player_id: p.id, data: p, updated_at: new Date().toISOString() }))
        );
        if (error) console.error("[DB] Spieler-Log Fehler:", error.message);
    } catch(e) {
        console.error("[DB] Spieler-Log Fehler:", e.message);
    }
}, 30000);
