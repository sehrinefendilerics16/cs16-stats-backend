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

    // 🔥 HISTORY (5 DK'DA 1)
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
  const top3 = players.slice(0, 3);

  let html = `
  <html>
  <head>
  <title>SEHRIN EFENDILERI</title>
  <style>

  body { background:#0f172a;color:white;font-family:Arial;margin:0; }

  h1 {
    text-align:center;
    padding:20px;
    background:#020617;
    margin:0;
  }

  .search {
    text-align:center;
    margin:20px;
  }

  .search input {
    padding:10px;
    width:250px;
    border-radius:8px;
    border:none;
  }

  .search button {
    padding:10px;
    border:none;
    border-radius:8px;
    background:#38bdf8;
    cursor:pointer;
  }

  .top3 {
    display:flex;
    justify-content:center;
    gap:20px;
  }

  .card {
    padding:20px;
    border-radius:12px;
    width:200px;
    text-align:center;
    font-weight:bold;
  }

  .gold { background:#facc15; color:black; }
  .silver { background:#e5e7eb; color:black; }
  .bronze { background:#fb923c; color:black; }

  table { width:95%; margin:auto; border-collapse:collapse; }

  th { background:#1e293b; padding:10px; }
  td { padding:8px; text-align:center; border-bottom:1px solid #334155; }

  tr:nth-child(even){ background:#020617; }
  tr:hover { background:#1e293b; }

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

  <div class="top3">
    <div class="card silver">🥈 ${top3[1]?.nick || ""}</div>
    <div class="card gold">🥇 ${top3[0]?.nick || ""}</div>
    <div class="card bronze">🥉 ${top3[2]?.nick || ""}</div>
  </div>

  <table>
  <tr>
    <th>#</th>
    <th>Nick</th>
    <th>Kill</th>
    <th>Death</th>
    <th>K/D</th>
    <th>Damage</th>
    <th>Rank</th>
  </tr>
  `;

  players.forEach((p, i) => {
    const kd = p.total_deaths === 0 ? p.total_kills : (p.total_kills / p.total_deaths).toFixed(2);
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

  const kd = p.total_deaths === 0 ? p.total_kills : (p.total_kills / p.total_deaths).toFixed(2);

  let level = "🟡 Ortalama";
  if (kd >= 2.5) level = "👑 Efsane";
  else if (kd >= 2) level = "🔥 Elit";
  else if (kd >= 1.2) level = "⚔️ İyi";
  else if (kd < 0.8) level = "💀 Zayıf";

  const tarih = new Date(p.updated_at).toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul"
  });

  res.send(`
  <html>
  <head>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

  <style>

  body { background:#f1f5f9; font-family:Arial; }

  .container { max-width:1100px; margin:auto; padding:20px; }

  .header {
    background:#020617;
    color:white;
    padding:40px;
    border-radius:16px;
    text-align:center;
  }

  .grid {
    display:grid;
    grid-template-columns:repeat(3,1fr);
    gap:20px;
    margin-top:20px;
  }

  .card {
    background:white;
    padding:25px;
    border-radius:14px;
    text-align:center;
  }

  .big {
    grid-column:span 3;
    background:#020617;
    color:white;
  }

  .big .value { font-size:60px; }

  </style>
  </head>

  <body>

  <div class="container">

    <div class="header">
      <h1>${nick}</h1>
      <div>${level}</div>
    </div>

    <div class="grid">

      <div class="card">Kill<br><b>${p.total_kills}</b></div>
      <div class="card">Death<br><b>${p.total_deaths}</b></div>

      <div class="card big">K/D<br><div class="value">${kd}</div></div>

      <div class="card">Damage<br><b>${p.total_damage}</b></div>
      <div class="card">Rank<br><b>${p.total_kills - p.total_deaths}</b></div>
      <div class="card">Durum<br><b>${level}</b></div>

    </div>

    <canvas id="chart" height="100"></canvas>

    <p style="text-align:center;">Son Güncelleme: ${tarih}</p>

  </div>

  <script>

  const data = ${JSON.stringify(history.rows)};

  const labels = data.map(x => new Date(x.created_at).toLocaleTimeString("tr-TR"));
  const kills = data.map(x => x.kills);

  new Chart(document.getElementById("chart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Kill Gelişimi",
        data: kills,
        borderColor: "#38bdf8"
      }]
    }
  });

  </script>

  </body>
  </html>
  `);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server çalıştı:", PORT);
  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
