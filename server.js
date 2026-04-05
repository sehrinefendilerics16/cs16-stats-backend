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

// TÜM SAYFALARI ÇEK
async function fetchAllPlayers() {
  let page = 1;
  let allPlayers = [];

  while (true) {
    try {
      console.log("Sayfa çekiliyor:", page);

      const url = `${BASE_URL}&page=${page}`;
      const { data } = await axios.get(url);
      const $ = cheerio.load(data);
      const rows = $("table tr");

      let count = 0;

      for (let i = 1; i < rows.length; i++) {
        const cols = $(rows[i]).find("td");
        if (cols.length < 10) continue;

        const nick = $(cols[1]).text().trim();
        const kills = parseInt($(cols[2]).text()) || 0;
        const deaths = parseInt($(cols[4]).text()) || 0;
        const damage = parseInt($(cols[9]).text()) || 0;

        if (!nick) continue;

        allPlayers.push({ nick, kills, deaths, damage });
        count++;
      }

      console.log(`Sayfa ${page}: ${count} oyuncu`);

      if (count === 0) break;

      page++;

    } catch (err) {
      console.error("Sayfa hatası:", err.message);
      break;
    }
  }

  return allPlayers;
}

// DELTA + DB KAYIT
async function fetchAndSave() {
  try {
    const players = await fetchAllPlayers();

    for (const pl of players) {
      const { nick, kills, deaths, damage } = pl;

      const existing = await pool.query(
        "SELECT * FROM players WHERE nick = $1",
        [nick]
      );

      if (existing.rows.length === 0) {
        // İLK KAYIT
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
          VALUES ($1, $2, $3, $4, $2, $3, $4)
        `, [nick, kills, deaths, damage]);

      } else {
        const p = existing.rows[0];

        let deltaKills = 0;
        let deltaDeaths = 0;
        let deltaDamage = 0;

        // KILL
        if (kills >= p.last_kills) {
          deltaKills = kills - p.last_kills;
        } else {
          deltaKills = kills;
        }

        // DEATH
        if (deaths >= p.last_deaths) {
          deltaDeaths = deaths - p.last_deaths;
        } else {
          deltaDeaths = deaths;
        }

        // DAMAGE
        if (damage >= p.last_damage) {
          deltaDamage = damage - p.last_damage;
        } else {
          deltaDamage = damage;
        }

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
          nick,
          deltaKills,
          deltaDeaths,
          deltaDamage,
          kills,
          deaths,
          damage
        ]);
      }
    }

    console.log("✔ Tüm veri işlendi");

  } catch (err) {
    console.error("❌ SCRAPER HATA:", err.message);
  }
}

// RANK SAYFA (DOĞRU FORMÜL)
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
    <title>CS 1.6 Rank</title>
    <style>
      body { background:#000; color:#fff; font-family:Arial; }
      table { width:90%; margin:auto; border-collapse:collapse; }
      td, th { padding:8px; border-bottom:1px solid #333; text-align:center; }
      h1 { text-align:center; }
    </style>
  </head>
  <body>
    <h1>PANEL AYNI RANK SİSTEMİ</h1>
    <table>
      <tr>
        <th>#</th>
        <th>Nick</th>
        <th>Kill</th>
        <th>Death</th>
        <th>Damage</th>
        <th>Rank</th>
      </tr>
  `;

  result.rows.forEach((p, i) => {
    html += `
      <tr>
        <td>${i + 1}</td>
        <td>${p.nick}</td>
        <td>${p.total_kills}</td>
        <td>${p.total_deaths}</td>
        <td>${p.total_damage}</td>
        <td>${p.total_kills - p.total_deaths}</td>
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
