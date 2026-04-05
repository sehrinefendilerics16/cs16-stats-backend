const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BASE_URL = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81&page=";

// DB INIT (YENİ ŞEMA)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      nick TEXT PRIMARY KEY,
      kills INTEGER,
      deaths INTEGER,
      rank_score INTEGER
    );
  `);
}

// TÜM SAYFALARI ÇEK
async function scrapeAllPages() {
  let page = 1;
  let allPlayers = [];

  while (true) {
    console.log("Sayfa çekiliyor:", page);

    const { data } = await axios.get(BASE_URL + page);
    const $ = cheerio.load(data);
    const rows = $("table tr");

    if (rows.length <= 1) break; // veri bitti

    let count = 0;

    for (let i = 1; i < rows.length; i++) {
      const cols = $(rows[i]).find("td");
      if (cols.length < 6) continue;

      const nick = $(cols[1]).text().trim();
      const kills = parseInt($(cols[2]).text()) || 0;
      const deaths = parseInt($(cols[4]).text()) || 0;

      const score = kills - deaths;

      allPlayers.push({
        nick,
        kills,
        deaths,
        score
      });

      count++;
    }

    console.log(`Sayfa ${page}: ${count} oyuncu`);

    page++;
  }

  return allPlayers;
}

// DB OVERWRITE
async function updateDatabase() {
  try {
    const players = await scrapeAllPages();

    console.log("Toplam oyuncu:", players.length);

    await pool.query("TRUNCATE players");

    for (const p of players) {
      await pool.query(`
        INSERT INTO players (nick, kills, deaths, rank_score)
        VALUES ($1, $2, $3, $4)
      `, [p.nick, p.kills, p.deaths, p.score]);
    }

    console.log("✔ DB tamamen güncellendi");

  } catch (err) {
    console.error("❌ HATA:", err.message);
  }
}

// RANK SAYFA
app.get("/", async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM players
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
    <h1>PANEL İLE BİREBİR RANK</h1>
    <table>
      <tr>
        <th>#</th>
        <th>Nick</th>
        <th>Kills</th>
        <th>Deaths</th>
        <th>Rank</th>
      </tr>
  `;

  result.rows.forEach((p, i) => {
    html += `
      <tr>
        <td>${i + 1}</td>
        <td>${p.nick}</td>
        <td>${p.kills}</td>
        <td>${p.deaths}</td>
        <td>${p.rank_score}</td>
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

  await initDB();
  await updateDatabase();

  setInterval(updateDatabase, 120000); // 2 dk
});
