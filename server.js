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

let isRunning = false;
let cache = {};

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
      last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// ================= CORE =================
async function fetchAndSave() {
  if (isRunning) return;
  isRunning = true;

  try {
    const players = await fetchPlayers();
    if (!players || players.length < 5) return;

    const all = await pool.query(`SELECT * FROM players`);
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
        p.damage === old.last_damage
      ) continue;

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

    await pool.query(`INSERT INTO system_log (last_fetch) VALUES (CURRENT_TIMESTAMP)`);
    cache = {};

  } catch (err) {
    console.error(err.message);
  } finally {
    isRunning = false;
  }
}

// ================= PLAYER DETAY =================
app.get("/player/:nick", async (req, res) => {

  const nick = req.params.nick;

  const result = await pool.query(`
    SELECT *,
      (total_kills::float / GREATEST(total_deaths,1)) AS kd
    FROM players
    WHERE nick = $1
  `, [nick]);

  const p = result.rows[0];
  if (!p) return res.send("Oyuncu bulunamadı");

  const kd = p.kd || 0;

  res.send(`
  <html>
  <head>
  <style>
  body{background:#0f172a;color:white;font-family:Arial;text-align:center}
  .box{margin-top:50px}
  .good{color:#22c55e}
  .bad{color:#ef4444}
  a{color:#38bdf8}
  </style>
  </head>
  <body>
  <div class="box">
    <h1>${escapeHTML(p.nick)}</h1>
    <p>K/D: <span class="${kd>=2?'good':kd<1?'bad':''}">${kd.toFixed(2)}</span></p>
    <p>Kill: ${p.total_kills}</p>
    <p>Death: ${p.total_deaths}</p>
    <p>Hasar: ${p.total_damage}</p>
    <p>HS: %${p.hs_percent}</p>
    <p>Accuracy: %${p.accuracy}</p>
    <br><a href="/">← Geri</a>
  </div>
  </body>
  </html>
  `);
});

// ================= ROUTES =================
app.get("/status", async (req, res) => {
  const result = await pool.query(`
    SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1
  `);

  const last = result.rows[0]?.last_fetch;

  res.send(`
  <html>
  <head>
  <style>
    body {background:#0f172a;color:white;font-family:Arial;text-align:center;padding-top:50px;}
    .box {background:#020617;display:inline-block;padding:30px;border-radius:12px;}
    .time {color:#38bdf8;font-size:18px;}
  </style>
  </head>
  <body>
    <div class="box">
      <h1>📊 Sistem Durumu</h1>
      <div class="time">
        ${last ? new Date(last).toLocaleString("tr-TR", {
          timeZone: "Europe/Istanbul",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }) : "Veri yok"}
      </div>
    </div>
  </body>
  </html>
  `);
});

app.get("/", async (req, res) => {

  const search = (req.query.search || "").toLowerCase();

  if (cache[search] && Date.now() - cache[search].time < 30000) {
    return res.send(cache[search].data);
  }

  const result = await pool.query(`
    SELECT *,
      (total_kills::float / GREATEST(total_deaths,1)) AS kd
    FROM players
    WHERE LOWER(nick) LIKE $1
  `, [`%${search}%`]);

  let players = result.rows;

  players = players.map(p => {
    const kd = p.kd || 0;
    const activity = Math.min(p.total_kills / 50, 1);

    const score =
      ((p.total_kills - p.total_deaths) * 0.8) +
      (kd * 8) +
      (p.hs_percent * 2.5) +
      (p.accuracy * 2) +
      (p.total_damage / 1000);

    return { ...p, score: score * activity };
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
  .search{text-align:center;margin:15px}
  input{padding:10px;border-radius:8px;border:none}
  button{padding:10px;border-radius:8px;border:none;background:#38bdf8}
  .info{text-align:center;color:#94a3b8;margin-top:10px}
  table{width:95%;margin:auto;border-collapse:collapse}
  th{background:#1e293b;padding:10px}
  td{padding:8px;text-align:center;border-bottom:1px solid #334155}
  a{color:white;text-decoration:none}
  a:hover{color:#38bdf8}
  </style>
  </head>

  <body>

  <h1>SEHRIN EFENDILERI</h1>

  <div class="info">
    ⚠️ Sıralama verileri 30.03.2026 tarihinden itibaren hesaplanmaktadır.
  </div>

  <div class="top">
    <div class="box g">🥇 ${top3[0]?.nick||""}</div>
    <div class="box s">🥈 ${top3[1]?.nick||""}</div>
    <div class="box b">🥉 ${top3[2]?.nick||""}</div>
  </div>

  <form class="search">
    <input name="search" placeholder="Oyuncu ara..." value="${search}">
    <button type="submit">Ara</button>
  </form>

  <table>
  <tr>
    <th>#</th>
    <th>Oyuncu</th>
    <th>Öldürme</th>
    <th>Ölüm</th>
    <th>K/D</th>
    <th>Hasar</th>
    <th>SKOR</th>
  </tr>
  `;

  players.forEach((p,i)=>{
    html+=`
    <tr>
      <td>${i+1}</td>
      <td><a href="/player/${encodeURIComponent(p.nick)}">${escapeHTML(p.nick)}</a></td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td>${p.kd.toFixed(2)}</td>
      <td>${p.total_damage}</td>
      <td>${Math.round(p.score)}</td>
    </tr>`;
  });

  html+=`</table></body></html>`;

  cache[search] = { data: html, time: Date.now() };

  res.send(html);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await initDB();
  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
