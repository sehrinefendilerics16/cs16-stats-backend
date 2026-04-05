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

// 🔥 SCRAPER
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
    const headshot = parseInt($(cols[3]).text()) || 0;
    const deaths = parseInt($(cols[4]).text()) || 0;
    const bullets = parseInt($(cols[5]).text()) || 0;
    const hits = parseInt($(cols[6]).text()) || 0;
    const damage = parseInt($(cols[7]).text()) || 0;

    if (!nick || nick === "." || nick === "|" || nick.includes("Toplam")) return;

    players.push({
      nick,
      kills,
      headshot,
      deaths,
      bullets,
      hits,
      damage
    });
  });

  console.log("Çekilen oyuncu:", players.length);
  return players;
}

// 🔥 DB KAYIT (DELTA)
async function fetchAndSave() {
  try {
    const players = await fetchPlayers();

    for (const p of players) {
      const existing = await pool.query(
        "SELECT * FROM players WHERE nick=$1",
        [p.nick]
      );

      if (existing.rows.length === 0) {
        await pool.query(`
          INSERT INTO players (
            nick,
            total_kills,
            total_deaths,
            total_damage,
            last_kills,
            last_deaths,
            last_damage
          )
          VALUES ($1,$2,$3,$4,$2,$3,$4)
        `, [p.nick, p.kills, p.deaths, p.damage]);

      } else {
        const old = existing.rows[0];

        const isReset =
          p.kills < old.last_kills ||
          p.deaths < old.last_deaths ||
          p.damage < old.last_damage;

        const deltaKills = isReset ? p.kills : (p.kills - old.last_kills);
        const deltaDeaths = isReset ? p.deaths : (p.deaths - old.last_deaths);
        const deltaDamage = isReset ? p.damage : (p.damage - old.last_damage);

        await pool.query(`
          UPDATE players
          SET
            total_kills = total_kills + $2,
            total_deaths = total_deaths + $3,
            total_damage = total_damage + $4,
            last_kills = $5,
            last_deaths = $6,
            last_damage = $7,
            updated_at = CURRENT_TIMESTAMP
          WHERE nick = $1
        `, [
          p.nick,
          deltaKills,
          deltaDeaths,
          deltaDamage,
          p.kills,
          p.deaths,
          p.damage
        ]);
      }
    }

    console.log("✔ Veri güncellendi");

  } catch (err) {
    console.error("SCRAPER HATA:", err.message);
  }
}

// 🔥 MODERN PANEL
app.get("/", async (req, res) => {
  const result = await pool.query(`
    SELECT *,
    (total_kills - total_deaths) AS rank_score
    FROM players
    ORDER BY rank_score DESC
  `);

  let html = `
  <html>
  <head>
    <title>CS 1.6 Rank Sistemi</title>
    <style>
      body {
        margin:0;
        font-family: Arial;
        background: #f5f7fa;
      }

      .container {
        width: 95%;
        margin: auto;
      }

      h1 {
        text-align:center;
        padding:20px;
        margin:0;
        background:#1e293b;
        color:white;
      }

      .info {
        background:#e2e8f0;
        padding:15px;
        margin-top:15px;
        border-radius:8px;
      }

      table {
        width:100%;
        margin-top:20px;
        border-collapse:collapse;
        background:white;
        border-radius:8px;
        overflow:hidden;
      }

      th {
        background:#1e293b;
        color:white;
        padding:12px;
      }

      td {
        padding:10px;
        text-align:center;
        border-bottom:1px solid #ddd;
      }

      tr:hover {
        background:#f1f5f9;
      }

      .top1 { color: gold; font-weight:bold; }
      .top2 { color: silver; font-weight:bold; }
      .top3 { color: #cd7f32; font-weight:bold; }

      .kd {
        font-weight:bold;
      }
    </style>
  </head>
  <body>

  <h1>CS 1.6 RANK SİSTEMİ</h1>

  <div class="container">

    <div class="info">
      <b>Bilgilendirme:</b><br>
      - Sıralama = Kill - Death<br>
      - Veriler haftalık sıfırlanmaz, sürekli birikir<br>
      - Oyuncu performansı uzun vadeli takip edilir
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

  result.rows.forEach((p, i) => {
    const kd = p.total_deaths === 0
      ? p.total_kills
      : (p.total_kills / p.total_deaths).toFixed(2);

    let rankClass = "";
    if (i === 0) rankClass = "top1";
    else if (i === 1) rankClass = "top2";
    else if (i === 2) rankClass = "top3";

    html += `
      <tr class="${rankClass}">
        <td>${i + 1}</td>
        <td>${p.nick}</td>
        <td>${p.total_kills}</td>
        <td>${p.total_deaths}</td>
        <td class="kd">${kd}</td>
        <td>${p.total_damage}</td>
        <td>${p.total_kills - p.total_deaths}</td>
      </tr>
    `;
  });

  html += `
    </table>
  </div>
  </body>
  </html>
  `;

  res.send(html);
});

// 🔥 SERVER START
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server çalıştı:", PORT);

  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
