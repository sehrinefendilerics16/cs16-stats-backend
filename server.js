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

// 🔥 TABLO OLUŞTUR (otomatik)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      nick TEXT PRIMARY KEY,
      total_score INTEGER DEFAULT 0,
      last_score INTEGER DEFAULT 0
    );
  `);
}

// 🔥 VERİ ÇEK
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

      await pool.query(`
        INSERT INTO players (nick, total_score, last_score)
        VALUES ($1, $2, $3)
        ON CONFLICT (nick)
        DO UPDATE SET
          total_score = EXCLUDED.total_score,
          last_score = EXCLUDED.last_score
      `, [nick, damage, kills]);
    }

    console.log("✔ Veri güncellendi");
  } catch (err) {
    console.error("❌ HATA:", err.message);
  }
}

// 🌐 WEB
app.get("/", async (req, res) => {
  const result = await pool.query(`
    SELECT *
    FROM players
    ORDER BY total_score DESC
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
    <h1>CS 1.6 GENEL RANK</h1>
    <table>
      <tr>
        <th>#</th>
        <th>Nick</th>
        <th>Total Score</th>
        <th>Last Score</th>
      </tr>
  `;

  result.rows.forEach((p, i) => {
    html += `
      <tr>
        <td>${i + 1}</td>
        <td>${p.nick}</td>
        <td>${p.total_score}</td>
        <td>${p.last_score}</td>
      </tr>
    `;
  });

  html += "</table></body></html>";

  res.send(html);
});

// 🚀 BAŞLAT
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server çalışıyor:", PORT);

  await initDB();
  console.log("DB hazır");

  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
