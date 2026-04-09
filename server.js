const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BASE_URL = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";

let isRunning = false;
let cache = {};
const CACHE_LIMIT = 50;

// ================= CACHE CLEAN =================
function cleanCache() {
  const now = Date.now();

  for (const key in cache) {
    if (now - cache[key].time > 30000) {
      delete cache[key];
    }
  }

  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    const sorted = keys.sort((a, b) => cache[a].time - cache[b].time);
    const toDelete = sorted.slice(0, keys.length - CACHE_LIMIT);
    toDelete.forEach(k => delete cache[k]);
  }
}

// ================= XSS =================
function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[m]));
}

// ================= DB =================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nick TEXT UNIQUE,
      total_kills INT DEFAULT 0,
      total_deaths INT DEFAULT 0,
      total_damage INT DEFAULT 0,
      last_kills INT DEFAULT 0,
      last_deaths INT DEFAULT 0,
      last_damage INT DEFAULT 0,
      hs_percent FLOAT DEFAULT 0,
      accuracy FLOAT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nick ON players (LOWER(nick));`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_log (
      id SERIAL PRIMARY KEY,
      last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_hash TEXT
    );
  `);
}

// ================= SCRAPER =================
async function fetchPlayers(retry = 2) {
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 5000 });

    const $ = cheerio.load(data);
    const players = [];

    $("table.CSS_Table_Example tr").each((i, row) => {
      if (i === 0) return;

      const cols = $(row).find("td");
      if (cols.length !== 8) return;

      const nick = $(cols[1]).text().trim();
      const kills = parseInt($(cols[2]).text()) || 0;

      const hsText = $(cols[3]).text().trim();
      const hsMatch = hsText.match(/\((.*?)%\)/);
      const hsPercent = hsMatch ? parseFloat(hsMatch[1]) : 0;

      const deaths = parseInt($(cols[4]).text()) || 0;

      const accText = $(cols[6]).text().trim();
      const accMatch = accText.match(/\((.*?)%\)/);
      const accuracy = accMatch ? parseFloat(accMatch[1]) : 0;

      const damage = parseInt($(cols[7]).text()) || 0;

      if (!nick || nick.includes("Toplam")) return;

      players.push({ nick, kills, deaths, damage, hsPercent, accuracy });
    });

    return players;

  } catch (err) {
    if (retry > 0) return fetchPlayers(retry - 1);
    throw err;
  }
}

// ================= HASH =================
function generateHash(players) {
  return crypto.createHash("md5").update(JSON.stringify(players)).digest("hex");
}

// ================= CORE =================
async function fetchAndSave() {
  if (isRunning) return;
  isRunning = true;

  try {
    const players = await fetchPlayers();
    if (!players || players.length < 5) return;

    const newHash = generateHash(players);

    const lastHashRes = await pool.query(`
      SELECT last_hash FROM system_log ORDER BY id DESC LIMIT 1
    `);

    const lastHash = lastHashRes.rows[0]?.last_hash;

    if (lastHash && lastHash === newHash) {
      await pool.query(`
        INSERT INTO system_log (last_fetch, last_hash) 
        VALUES (CURRENT_TIMESTAMP, $1)
      `, [newHash]);
      return;
    }

    const all = await pool.query(`SELECT nick, last_kills, last_deaths, last_damage, hs_percent, accuracy FROM players`);
    const map = new Map(all.rows.map(p => [p.nick, p]));

    for (const p of players) {
      const old = map.get(p.nick);

      if (!old) {
        await pool.query(`
          INSERT INTO players 
          (nick,total_kills,total_deaths,total_damage,last_kills,last_deaths,last_damage,hs_percent,accuracy)
          VALUES ($1,$2,$3,$4,$2,$3,$4,$5,$6)
        `, [p.nick, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
        continue;
      }

      if (
        p.kills === old.last_kills &&
        p.deaths === old.last_deaths &&
        p.damage === old.last_damage &&
        p.hsPercent === old.hs_percent &&
        p.accuracy === old.accuracy
      ) continue;

      if (
        p.kills === old.last_kills &&
        p.deaths === old.last_deaths &&
        p.damage === old.last_damage
      ) {
        await pool.query(`
          UPDATE players SET
            hs_percent = $2,
            accuracy = $3,
            updated_at = CURRENT_TIMESTAMP
          WHERE nick = $1
        `, [p.nick, p.hsPercent, p.accuracy]);
        continue;
      }

      const isReset =
        p.kills < old.last_kills ||
        p.deaths < old.last_deaths ||
        p.damage < old.last_damage;

      const dk = isReset ? p.kills : p.kills - old.last_kills;
      const dd = isReset ? p.deaths : p.deaths - old.last_deaths;
      const dmg = isReset ? p.damage : p.damage - old.last_damage;

      await pool.query(`
        UPDATE players SET
          total_kills = total_kills + $2,
          total_deaths = total_deaths + $3,
          total_damage = total_damage + $4,
          last_kills = $5,
          last_deaths = $6,
          last_damage = $7,
          hs_percent = $8,
          accuracy = $9,
          updated_at = CURRENT_TIMESTAMP
        WHERE nick = $1
      `, [p.nick, dk, dd, dmg, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
    }

    await pool.query(`
      INSERT INTO system_log (last_fetch, last_hash) 
      VALUES (CURRENT_TIMESTAMP, $1)
    `, [newHash]);

    cache = {};

  } catch (err) {
    console.error("FETCH ERROR:", err.message);
  } finally {
    isRunning = false;
  }
}

// ================= FIX DB =================
app.get("/fix-db", async (req, res) => {
  try {
    await pool.query(`ALTER TABLE system_log ADD COLUMN last_hash TEXT;`);
    res.send("OK - DB FIXED");
  } catch (e) {
    res.send("HATA: " + e.message);
  }
});

// ================= ROUTES =================
app.get("/status", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1
    `);

    const last = result.rows[0]?.last_fetch;

    const formatted = last
      ? new Date(last).toLocaleString("tr-TR", {
          timeZone: "Europe/Istanbul",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        })
      : "Veri yok";

    res.send(`
    <html>
    <body style="background:#0f172a;color:white;text-align:center;padding-top:80px;">
      <h2>📊 Sistem Son Güncelleme</h2>
      <h3>${formatted}</h3>
    </body>
    </html>
    `);
  } catch (err) {
    res.send("HATA: " + err.message);
  }
});

app.get("/force-update", async (req, res) => {
  await fetchAndSave();
  res.send("OK");
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await initDB();
  await fetchAndSave();
  setInterval(fetchAndSave, 180000);
});
