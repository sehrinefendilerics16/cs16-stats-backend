const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BASE_URL = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";

// ================= DB INIT =================
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
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_history (
      id SERIAL PRIMARY KEY,
      nick TEXT,
      kills INT,
      deaths INT,
      damage INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ================= SCRAPER =================
async function fetchPlayers() {
  const { data } = await axios.get(BASE_URL);
  const $ = cheerio.load(data);

  const players = [];
  const rows = $("table.CSS_Table_Example tr");

  rows.each((i, row) => {
    if (i === 0) return;

    const cols = $(row).find("td");
    if (cols.length !== 8) return;

    const nick = $(cols[1]).text().trim();
    const kills = parseInt($(cols[2]).text()) || 0;
    const deaths = parseInt($(cols[4]).text()) || 0;
    const damage = parseInt($(cols[7]).text()) || 0;

    if (!nick || nick.includes("Toplam")) return;

    players.push({ nick, kills, deaths, damage });
  });

  return players;
}

// ================= DB UPDATE =================
async function fetchAndSave() {
  const players = await fetchPlayers();

  for (const p of players) {
    const existing = await pool.query("SELECT * FROM players WHERE nick=$1", [p.nick]);

    if (existing.rows.length === 0) {
      await pool.query(`
        INSERT INTO players (
          nick,total_kills,total_deaths,total_damage,
          last_kills,last_deaths,last_damage
        )
        VALUES ($1,$2,$3,$4,$2,$3,$4)
      `, [p.nick, p.kills, p.deaths, p.damage]);
    } else {
      const old = existing.rows[0];

      const dk = p.kills - old.last_kills;
      const dd = p.deaths - old.last_deaths;
      const dmg = p.damage - old.last_damage;

      await pool.query(`
        UPDATE players SET
          total_kills = total_kills + $2,
          total_deaths = total_deaths + $3,
          total_damage = total_damage + $4,
          last_kills = $5,
          last_deaths = $6,
          last_damage = $7,
          updated_at = CURRENT_TIMESTAMP
        WHERE nick = $1
      `, [p.nick, dk, dd, dmg, p.kills, p.deaths, p.damage]);
    }

    if (new Date().getMinutes() % 5 === 0) {
      await pool.query(`
        INSERT INTO player_history (nick, kills, deaths, damage)
        VALUES ($1,$2,$3,$4)
      `, [p.nick, p.kills, p.deaths, p.damage]);
    }
  }
}

// ================= ANA SAYFA =================
app.get("/", async (req, res) => {

  const search = req.query.search;

  const result = search
    ? await pool.query(`SELECT *, (total_kills-total_deaths) AS rank_score FROM players WHERE LOWER(nick) LIKE LOWER($1) ORDER BY rank_score DESC`, [`%${search}%`])
    : await pool.query(`SELECT *, (total_kills-total_deaths) AS rank_score FROM players ORDER BY rank_score DESC`);

  const players = result.rows;
  const top3 = players.slice(0,3);

  let html = `
  <html>
  <head>
  <style>
  body { background:#0f172a;color:white;font-family:Arial;margin:0; }
  h1 { text-align:center;padding:20px;background:#020617;margin:0; }

  .top3 { display:flex;justify-content:center;gap:20px;margin:20px; }
  .card { padding:15px 25px;border-radius:10px;font-weight:bold; }
  .gold { background:#facc15;color:black; }
  .silver { background:#cbd5f5;color:black; }
  .bronze { background:#fb923c;color:black; }

  .search { text-align:center;margin:20px; }

  input { padding:10px;border-radius:8px;border:none; }
  button { padding:10px;border-radius:8px;border:none;background:#38bdf8; }

  table { width:95%; margin:auto; border-collapse:collapse; }
  th { background:#1e293b;padding:10px; }
  td { padding:8px;text-align:center;border-bottom:1px solid #334155; }

  a { color:#38bdf8;text-decoration:none; }
  </style>
  </head>

  <body>

  <h1>SEHRIN EFENDILERI</h1>

  <div class="top3">
    <div class="card gold">🥇 ${top3[0]?.nick || ""}</div>
    <div class="card silver">🥈 ${top3[1]?.nick || ""}</div>
    <div class="card bronze">🥉 ${top3[2]?.nick || ""}</div>
  </div>

  <form class="search">
    <input name="search" placeholder="Oyuncu ara..." />
    <button>Bul</button>
  </form>

  <table>
  <tr>
    <th>#</th>
    <th>Oyuncu</th>
    <th>Öldürme</th>
    <th>Ölüm</th>
    <th>K/D</th>
    <th>Hasar</th>
    <th>Puan</th>
  </tr>
  `;

  players.forEach((p,i)=>{
    const kd = (p.total_kills / (p.total_deaths||1)).toFixed(2);

    html+=`
    <tr>
      <td>${i+1}</td>
      <td><a href="/player/${encodeURIComponent(p.nick)}">${p.nick}</a></td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td>${kd}</td>
      <td>${p.total_damage}</td>
      <td>${p.total_kills - p.total_deaths}</td>
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
  setInterval(fetchAndSave, 60000);
});
