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

let isRunning = false; // 🔥 DOUBLE RUN KORUMA

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
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_log (
      id SERIAL PRIMARY KEY,
      last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ================= SCRAPER =================
async function fetchPlayers() {
  const { data } = await axios.get(BASE_URL, { timeout: 5000 }); // 🔥 TIMEOUT

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

    if (!nick || nick.includes("Toplam")) return;

    players.push({ nick, kills, deaths, damage });
  });

  return players;
}

// ================= CORE =================
async function fetchAndSave() {

  if (isRunning) {
    console.log("⛔ Zaten çalışıyor, skip");
    return;
  }

  isRunning = true;

  try {
    const players = await fetchPlayers();

    // 🔥 BOZUK VERİ KONTROLÜ
    if (!players || players.length < 5) {
      console.log("⚠️ Veri şüpheli, kayıt yapılmadı");
      return;
    }

    for (const p of players) {
      const res = await pool.query("SELECT * FROM players WHERE nick=$1", [p.nick]);

      if (res.rows.length === 0) {
        await pool.query(`
          INSERT INTO players (nick,total_kills,total_deaths,total_damage,last_kills,last_deaths,last_damage)
          VALUES ($1,$2,$3,$4,$2,$3,$4)
        `, [p.nick, p.kills, p.deaths, p.damage]);
        continue;
      }

      const old = res.rows[0];

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
          updated_at = CURRENT_TIMESTAMP
        WHERE nick = $1
      `, [p.nick, dk, dd, dmg, p.kills, p.deaths, p.damage]);
    }

    console.log("✔ Veri güncellendi:", new Date().toLocaleTimeString());

    await pool.query(`
      INSERT INTO system_log (last_fetch)
      VALUES (CURRENT_TIMESTAMP)
    `);

  } catch (err) {
    console.error("❌ HATA:", err.message);
  } finally {
    isRunning = false; // 🔥 KİLİT AÇ
  }
}

// ================= ROUTES =================
app.get("/force-update", async (req, res) => {
  await fetchAndSave();
  res.send("Manuel veri çekildi ✔");
});

app.get("/status", async (req, res) => {
  const result = await pool.query(`
    SELECT last_fetch FROM system_log
    ORDER BY id DESC
    LIMIT 1
  `);

  const last = result.rows[0];

  res.send(`
    <h2>Son Veri Çekim Zamanı</h2>
    <p>${last ? last.last_fetch : "Henüz veri yok"}</p>
  `);
});

// ================= PANEL =================
app.get("/", async (req, res) => {

  const search = req.query.search || "";

  const result = await pool.query(`
    SELECT *, (total_kills-total_deaths) AS puan
    FROM players
    WHERE LOWER(nick) LIKE LOWER($1)
    ORDER BY puan DESC
  `, [`%${search}%`]);

  const players = result.rows;
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

  .search{text-align:center;margin:20px}
  input{padding:10px;border-radius:8px;border:none}
  button{padding:10px;border-radius:8px;border:none;background:#38bdf8}

  table{width:95%;margin:auto;border-collapse:collapse}
  th{background:#1e293b;padding:10px}
  td{padding:8px;text-align:center;border-bottom:1px solid #334155}

  .good{color:#22c55e}
  .bad{color:#ef4444}
  </style>
  </head>

  <body>

  <h1>SEHRIN EFENDILERI</h1>

  <div class="top">
    <div class="box g">🥇 ${top3[0]?.nick||""}</div>
    <div class="box s">🥈 ${top3[1]?.nick||""}</div>
    <div class="box b">🥉 ${top3[2]?.nick||""}</div>
  </div>

  <form class="search">
    <input name="search" placeholder="Oyuncu ara..." value="${search}" />
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
    const kd = (p.total_kills/(p.total_deaths||1)).toFixed(2);

    html+=`
    <tr>
      <td>${i+1}</td>
      <td>${p.nick}</td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td class="${kd>=2?'good':kd<1?'bad':''}">${kd}</td>
      <td>${p.total_damage}</td>
      <td>${p.puan}</td>
    </tr>`;
  });

  html+=`</table></body></html>`;
  res.send(html);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server çalıştı:", PORT);

  await initDB();
  await fetchAndSave();

  setInterval(fetchAndSave, 60000);
});
