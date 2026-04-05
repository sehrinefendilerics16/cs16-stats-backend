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
    const existing = await pool.query(
      "SELECT * FROM players WHERE nick=$1",
      [p.nick]
    );

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

    // 🔥 her 5 dk history
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

  let result;

  if (search) {
    result = await pool.query(`
      SELECT *, (total_kills - total_deaths) AS rank_score
      FROM players
      WHERE LOWER(nick) LIKE LOWER($1)
      ORDER BY rank_score DESC
    `, [`%${search}%`]);
  } else {
    result = await pool.query(`
      SELECT *, (total_kills - total_deaths) AS rank_score
      FROM players
      ORDER BY rank_score DESC
    `);
  }

  const players = result.rows;

  let html = `
  <html>
  <head>
  <title>SEHRIN EFENDILERI</title>

  <style>
  body { background:#0f172a;color:white;font-family:Arial;margin:0; }
  h1 { text-align:center;padding:20px;background:#020617;margin:0; }

  .search { text-align:center;margin:20px; }

  input { padding:10px;border-radius:8px;border:none; }
  button { padding:10px;border-radius:8px;border:none;background:#38bdf8;cursor:pointer; }

  table { width:95%; margin:auto; border-collapse:collapse; }
  th { background:#1e293b;padding:10px; }
  td { padding:8px;text-align:center;border-bottom:1px solid #334155; }

  .kd-good { color:#22c55e; }
  .kd-bad { color:#ef4444; }

  a { color:#38bdf8; text-decoration:none; }
  </style>
  </head>

  <body>

  <h1>SEHRIN EFENDILERI</h1>

  <form class="search">
    <input name="search" placeholder="Nick ara..." />
    <button>Bul</button>
  </form>

  <table>
  <tr>
    <th>#</th><th>Nick</th><th>Kill</th><th>Death</th><th>K/D</th><th>Damage</th><th>Rank</th>
  </tr>
  `;

  players.forEach((p, i) => {
    const kd = p.total_deaths === 0
      ? p.total_kills
      : (p.total_kills / p.total_deaths).toFixed(2);

    const kdClass = kd >= 2 ? "kd-good" : kd < 1 ? "kd-bad" : "";

    html += `
    <tr>
      <td>${i+1}</td>
      <td><a href="/player/${encodeURIComponent(p.nick)}">${p.nick}</a></td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td class="${kdClass}">${kd}</td>
      <td>${p.total_damage}</td>
      <td>${p.total_kills - p.total_deaths}</td>
    </tr>`;
  });

  html += `</table></body></html>`;
  res.send(html);
});

// ================= PROFİL =================
app.get("/player/:nick", async (req, res) => {

  const nick = decodeURIComponent(req.params.nick);

  const player = await pool.query("SELECT * FROM players WHERE nick=$1", [nick]);
  const history = await pool.query(`
    SELECT * FROM player_history WHERE nick=$1 ORDER BY created_at ASC
  `, [nick]);

  if (player.rows.length === 0) return res.send("Oyuncu yok");

  const p = player.rows[0];

  const kd = p.total_deaths === 0
    ? p.total_kills
    : (p.total_kills / p.total_deaths).toFixed(2);

  const durum =
    kd >= 2 ? "🔥 Elit Oyuncu" :
    kd >= 1 ? "⚖️ Ortalama" :
    "💀 Zayıf Oyuncu";

  const tarih = new Date(p.updated_at).toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul"
  });

  res.send(`
  <html>
  <head>
  <title>${nick}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

  <style>
  body { background:#0f172a;color:white;font-family:Arial;margin:0; }
  .container { max-width:1000px;margin:auto;padding:20px; }
  .header { background:#020617;padding:25px;border-radius:12px;text-align:center;font-size:28px;margin-bottom:20px; }

  .grid { display:grid;grid-template-columns: repeat(3, 1fr);gap:15px; }

  .card { background:#1e293b;padding:20px;border-radius:10px;text-align:center; }

  .value { font-size:22px;margin-top:5px; }

  .kd-good { color:#22c55e; }
  .kd-bad { color:#ef4444; }

  canvas { background:#020617;border-radius:10px;padding:10px;margin-top:20px; }

  .info { text-align:center;margin-top:15px;opacity:0.7; }

  a { color:#38bdf8;text-decoration:none; }
  </style>
  </head>

  <body>

  <div class="container">

    <div class="header">${nick}<br><small>${durum}</small></div>

    <div class="grid">
      <div class="card">Kill<div class="value">${p.total_kills}</div></div>
      <div class="card">Death<div class="value">${p.total_deaths}</div></div>
      <div class="card">K/D<div class="value ${kd>=2?"kd-good":kd<1?"kd-bad":""}">${kd}</div></div>
      <div class="card">Damage<div class="value">${p.total_damage}</div></div>
      <div class="card">Rank<div class="value">${p.total_kills - p.total_deaths}</div></div>
      <div class="card">Durum<div class="value">${durum}</div></div>
    </div>

    ${
      history.rows.length < 3
        ? `<div class="info">Veri toplanıyor...</div>`
        : `<canvas id="chart"></canvas>`
    }

    <div class="info">Son Güncelleme: ${tarih}</div>

    <div class="info"><a href="/">← Ana Sayfa</a></div>

  </div>

  <script>
  const raw = ${JSON.stringify(history.rows)};

  if (raw.length >= 3) {
    const labels = raw.map(x => new Date(x.created_at).toLocaleTimeString("tr-TR"));
    const kills = raw.map(x => x.kills);
    const deaths = raw.map(x => x.deaths);
    const damage = raw.map(x => x.damage);

    new Chart(document.getElementById("chart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Kill", data: kills, borderColor:"#22c55e", tension:0.3 },
          { label: "Death", data: deaths, borderColor:"#ef4444", tension:0.3 },
          { label: "Damage", data: damage, borderColor:"#f59e0b", tension:0.3 }
        ]
      },
      options: {
        plugins: { legend:{ labels:{ color:"white" } } },
        scales: {
          x:{ ticks:{ color:"white" } },
          y:{ ticks:{ color:"white" } }
        }
      }
    });
  }
  </script>

  </body>
  </html>
  `);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server çalıştı:", PORT);

  await initDB();

  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
