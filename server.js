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
  }
}

// ================= ANA SAYFA =================
app.get("/", async (req, res) => {
  const result = await pool.query(`
    SELECT *, (total_kills - total_deaths) AS rank_score
    FROM players
    ORDER BY rank_score DESC
  `);

  const players = result.rows;
  const top3 = players.slice(0, 3);

  let html = `
  <html>
  <head>
  <title>SEHRIN EFENDILERI</title>
  <style>
  body { background:#0f172a;color:white;font-family:Arial;margin:0; }
  h1 { text-align:center;padding:20px;background:#020617;margin:0; }

  .container { width:95%; margin:auto; }

  .top3 { display:flex; justify-content:center; gap:20px; margin-top:20px; }
  .card { padding:20px; border-radius:12px; width:200px; text-align:center; font-weight:bold; }

  .gold { background:#facc15; color:black; box-shadow:0 0 20px #facc15; }
  .silver { background:#e5e7eb; color:black; box-shadow:0 0 15px #e5e7eb; }
  .bronze { background:#fb923c; color:black; box-shadow:0 0 15px #fb923c; }

  table { width:100%; margin-top:20px; border-collapse:collapse; }
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

  <div class="container">

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
    let kdClass = kd >= 2 ? "kd-good" : kd < 1 ? "kd-bad" : "";

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

  html += `</table></div></body></html>`;
  res.send(html);
});

// ================= PROFİL SAYFASI =================
app.get("/player/:nick", async (req, res) => {
  const nick = decodeURIComponent(req.params.nick);

  const result = await pool.query(
    "SELECT * FROM players WHERE nick=$1",
    [nick]
  );

  if (result.rows.length === 0) {
    return res.send("Oyuncu bulunamadı");
  }

  const p = result.rows[0];
  const kd = p.total_deaths === 0 ? p.total_kills : (p.total_kills / p.total_deaths).toFixed(2);

  let kdColor = "#64748b";
  if (kd >= 2) kdColor = "#22c55e";
  else if (kd < 1) kdColor = "#ef4444";

  let level = "Ortalama";
  if (kd >= 2) level = "🔥 Elit Oyuncu";
  else if (kd < 1) level = "💀 Zayıf Oyuncu";

  const tarih = new Date(p.updated_at).toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul"
  });

  res.send(`
  <html>
  <head>
  <title>${nick}</title>
  <style>

  body {
    background:#f1f5f9;
    font-family:Arial;
    margin:0;
  }

  .container {
    max-width:1200px;
    margin:40px auto;
    padding:20px;
  }

  .header {
    background:#0f172a;
    color:white;
    padding:40px;
    border-radius:16px;
    text-align:center;
  }

  .header h1 {
    margin:0;
    font-size:32px;
  }

  .level {
    margin-top:10px;
    font-size:18px;
    opacity:0.8;
  }

  .stats-grid {
    display:grid;
    grid-template-columns:repeat(3, 1fr);
    gap:20px;
    margin-top:30px;
  }

  .card {
    background:white;
    padding:25px;
    border-radius:14px;
    box-shadow:0 10px 25px rgba(0,0,0,0.08);
    text-align:center;
    transition:0.2s;
  }

  .card:hover {
    transform:translateY(-5px);
  }

  .title {
    color:#64748b;
    font-size:14px;
  }

  .value {
    font-size:32px;
    font-weight:bold;
    margin-top:10px;
  }

  .meta {
    margin-top:30px;
    text-align:center;
    color:#475569;
  }

  .back {
    display:inline-block;
    margin-top:15px;
    text-decoration:none;
    color:#0f172a;
    font-weight:bold;
  }

  @media(max-width:768px){
    .stats-grid {
      grid-template-columns:1fr;
    }
  }

  </style>
  </head>

  <body>

  <div class="container">

    <div class="header">
      <h1>${nick}</h1>
      <div class="level">${level}</div>
    </div>

    <div class="stats-grid">

      <div class="card">
        <div class="title">Kill</div>
        <div class="value">${p.total_kills}</div>
      </div>

      <div class="card">
        <div class="title">Death</div>
        <div class="value">${p.total_deaths}</div>
      </div>

      <div class="card">
        <div class="title">K/D</div>
        <div class="value" style="color:${kdColor}">${kd}</div>
      </div>

      <div class="card">
        <div class="title">Damage</div>
        <div class="value">${p.total_damage}</div>
      </div>

      <div class="card">
        <div class="title">Rank</div>
        <div class="value">${p.total_kills - p.total_deaths}</div>
      </div>

      <div class="card">
        <div class="title">Durum</div>
        <div class="value">${level}</div>
      </div>

    </div>

    <div class="meta">
      Son Güncelleme: ${tarih}
      <br>
      <a class="back" href="/">← Ana Sayfa</a>
    </div>

  </div>

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
