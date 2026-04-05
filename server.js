require('./setup'); // SADECE İLK ÇALIŞTIRMADA GEREKLİ (SONRA SİLECEĞİZ)

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TARGET_URL = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";

// DELTA SCRAPER
async function fetchAndSave() {
  try {
    const { data } = await axios.get(TARGET_URL);
    const $ = cheerio.load(data);
    const rows = $("table tr");

    for (let i = 1; i < rows.length; i++) {
      const cols = $(rows[i]).find("td");
      if (cols.length < 8) continue;

      const nick = $(cols[1]).text().trim();
      const kills = parseInt($(cols[2]).text()) || 0;
      const damage = parseInt($(cols[7]).text()) || 0;

      if (!nick) continue;

      const existing = await pool.query(
        "SELECT * FROM players WHERE nick = $1",
        [nick]
      );

      if (existing.rows.length === 0) {
        // İLK KAYIT
        await pool.query(`
          INSERT INTO players (
            nick, total_kills, total_damage, last_kills, last_damage
          )
          VALUES ($1, $2, $3, $2, $3)
        `, [nick, kills, damage]);

      } else {
        const p = existing.rows[0];

        let deltaKills = 0;
        let deltaDamage = 0;

        // KILL DELTA
        if (kills >= p.last_kills) {
          deltaKills = kills - p.last_kills;
        } else {
          deltaKills = kills; // RESET
        }

        // DAMAGE DELTA
        if (damage >= p.last_damage) {
          deltaDamage = damage - p.last_damage;
        } else {
          deltaDamage = damage; // RESET
        }

        await pool.query(`
          UPDATE players
          SET
            total_kills = total_kills + $2,
            total_damage = total_damage + $3,
            last_kills = $4,
            last_damage = $5,
            updated_at = CURRENT_TIMESTAMP
          WHERE nick = $1
        `, [nick, deltaKills, deltaDamage, kills, damage]);
      }
    }

    console.log("✔ Delta veri işlendi");
  } catch (err) {
    console.error("❌ HATA:", err.message);
  }
}

// RANK SAYFA
app.get("/", async (req, res) => {
  const result = await pool.query(`
    SELECT *,
    (total_kills * 2 + total_damage / 100) AS rank_score
    FROM players
    ORDER BY rank_score DESC
    LIMIT 100
  `);

  let html = `
  <html>
  <head>
    <title>CS 1.6 Rank</title>
    <style>
      body { background:#000; color:#fff; font-family:Arial; }
      table { width:80%; margin:auto; border-collapse:collapse; }
      td, th { padding:10px; border-bottom:1px solid #333; text-align:center; }
      h1 { text-align:center; }
    </style>
  </head>
  <body>
    <h1>DELTA RANK SİSTEMİ</h1>
    <table>
      <tr>
        <th>#</th>
        <th>Nick</th>
        <th>Total Kill</th>
        <th>Total Damage</th>
        <th>Rank</th>
      </tr>
  `;

  result.rows.forEach((p, i) => {
    html += `
      <tr>
        <td>${i + 1}</td>
        <td>${p.nick}</td>
        <td>${p.total_kills}</td>
        <td>${p.total_damage}</td>
        <td>${Math.floor(p.rank_score)}</td>
      </tr>
    `;
  });

  html += `</table></body></html>`;

  res.send(html);
});

// START
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server çalışıyor:", PORT);

  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
