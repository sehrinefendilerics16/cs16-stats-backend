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

// ================= CACHE =================
function cleanCache() {
  const now = Date.now();
  for (const key in cache) {
    if (now - cache[key].time > 30000) delete cache[key];
  }
}

// ================= XSS =================
function escapeHTML(str) {
  return str.replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_log (
      id SERIAL PRIMARY KEY,
      last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_hash TEXT
    );
  `);
}

// ================= SCRAPER =================
async function fetchPlayers() {
  const { data } = await axios.get(BASE_URL);
  const $ = cheerio.load(data);
  const players = [];

  $("table.CSS_Table_Example tr").each((i, row) => {
    if (i === 0) return;
    const cols = $(row).find("td");
    if (cols.length !== 8) return;

    const nick = $(cols[1]).text().trim();
    const kills = parseInt($(cols[2]).text()) || 0;
    const deaths = parseInt($(cols[4]).text()) || 0;
    const damage = parseInt($(cols[7]).text()) || 0;

    const hs = ($(cols[3]).text().match(/\((.*?)%\)/) || [0,0])[1];
    const acc = ($(cols[6]).text().match(/\((.*?)%\)/) || [0,0])[1];

    if (!nick || nick.includes("Toplam")) return;

    players.push({
      nick,
      kills,
      deaths,
      damage,
      hsPercent: parseFloat(hs) || 0,
      accuracy: parseFloat(acc) || 0
    });
  });

  return players;
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

    const last = await pool.query(`SELECT last_hash FROM system_log ORDER BY id DESC LIMIT 1`);
    const lastHash = last.rows[0]?.last_hash;

    if (lastHash === newHash) return;

    for (const p of players) {
      await pool.query(`
        INSERT INTO players (nick,total_kills,total_deaths,total_damage,last_kills,last_deaths,last_damage,hs_percent,accuracy)
        VALUES ($1,$2,$3,$4,$2,$3,$4,$5,$6)
        ON CONFLICT (nick) DO UPDATE SET
        total_kills = EXCLUDED.total_kills,
        total_deaths = EXCLUDED.total_deaths,
        total_damage = EXCLUDED.total_damage,
        last_kills = EXCLUDED.last_kills,
        last_deaths = EXCLUDED.last_deaths,
        last_damage = EXCLUDED.last_damage,
        hs_percent = EXCLUDED.hs_percent,
        accuracy = EXCLUDED.accuracy,
        updated_at = CURRENT_TIMESTAMP
      `, [p.nick, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
    }

    await pool.query(`INSERT INTO system_log (last_fetch,last_hash) VALUES (CURRENT_TIMESTAMP,$1)`, [newHash]);
    cache = {};

  } catch (err) {
    console.error(err.message);
  } finally {
    isRunning = false;
  }
}

// ================= FIX DB =================
app.get("/fix-db", async (req, res) => {
  try {
    await pool.query(`ALTER TABLE system_log ADD COLUMN last_hash TEXT;`);
    res.send("OK");
  } catch (e) {
    res.send(e.message);
  }
});

// ================= STATUS =================
app.get("/status", async (req, res) => {
  const r = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
  const t = r.rows[0]?.last_fetch;

  const formatted = t
    ? new Date(t).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })
    : "Veri yok";

  res.send(`
  <html>
  <body style="background:#0f172a;color:white;font-family:Arial;text-align:center;padding-top:100px;">
    <h2>📊 Son Güncelleme</h2>
    <h1>${formatted}</h1>
  </body>
  </html>
  `);
});

// ================= FORCE =================
app.get("/force-update", async (req, res) => {
  await fetchAndSave();

  res.send(`
  <html>
  <body style="background:#0f172a;color:white;text-align:center;padding-top:100px;">
    <h2>✅ Veri Güncellendi</h2>
  </body>
  </html>
  `);
});

// ================= PANEL =================
app.get("/", async (req, res) => {

  cleanCache();

  const result = await pool.query(`
    SELECT *,
    (total_kills - total_deaths) AS puan,
    (total_kills::float / GREATEST(total_deaths,1)) AS kd
    FROM players
  `);

  let players = result.rows.map(p => {
    const score =
      (p.total_kills - p.total_deaths) +
      (p.kd * 2.5) +
      (p.hs_percent * 1.5) +
      (Math.min(p.accuracy,35) * 0.3) +
      (p.total_damage / 800);

    return { ...p, score };
  });

  players.sort((a,b)=> b.score - a.score);

  const top3 = players.slice(0,3);

  let html = `
  <html>
  <head>
  <style>
  body{background:#0f172a;color:white;font-family:Arial;margin:0}
  h1{text-align:center;padding:20px;background:#020617;margin:0}
  .top{display:flex;justify-content:center;gap:20px;margin:20px}
  .box{padding:15px 25px;border-radius:10px;font-weight:bold}
  .g{background:#facc15;color:black}
  .s{background:#cbd5f5;color:black}
  .b{background:#fb923c;color:black}
  table{width:95%;margin:auto;border-collapse:collapse}
  th{background:#1e293b;padding:10px}
  td{padding:8px;text-align:center;border-bottom:1px solid #334155}
  </style>
  </head>

  <body>

  <h1>SEHRIN EFENDILERI</h1>

  <div class="top">
    <div class="box g">🥇 ${top3[0]?.nick||""}</div>
    <div class="box s">🥈 ${top3[1]?.nick||""}</div>
    <div class="box b">🥉 ${top3[2]?.nick||""}</div>
  </div>

  <table>
  <tr>
    <th>#</th>
    <th>Oyuncu</th>
    <th>K</th>
    <th>D</th>
    <th>KD</th>
    <th>DMG</th>
    <th>SKOR</th>
  </tr>
  `;

  players.forEach((p,i)=>{
    html+=`
    <tr>
      <td>${i+1}</td>
      <td>${escapeHTML(p.nick)}</td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td>${p.kd.toFixed(2)}</td>
      <td>${p.total_damage}</td>
      <td>${Math.round(p.score)}</td>
    </tr>`;
  });

  html+=`</table></body></html>`;

  res.send(html);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await initDB();
  await fetchAndSave();
  setInterval(fetchAndSave, 180000);
});
