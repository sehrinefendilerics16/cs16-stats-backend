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

// TEK SAYFA ÇEK
async function fetchPlayers() {
  const { data } = await axios.get(BASE_URL);
  const $ = cheerio.load(data);

  const players = [];

  $("table tr").each((i, row) => {
    if (i === 0) return;

    const cols = $(row).find("td");
    if (cols.length < 8) return;

    const nick = $(cols[1]).text().trim();
    const kills = parseInt($(cols[2]).text()) || 0;
    const deaths = parseInt($(cols[4]).text()) || 0;
    const damage = parseInt($(cols[7]).text()) || 0;

    if (!nick) return;

    players.push({ nick, kills, deaths, damage });
  });

  return players;
}

// DELTA SİSTEM
async function fetchAndSave() {
  const players = await fetchPlayers();

  for (const pl of players) {
    const { nick, kills, deaths, damage } = pl;

    const existing = await pool.query(
      "SELECT * FROM players WHERE nick = $1",
      [nick]
    );

    if (existing.rows.length === 0) {
      await pool.query(`
        INSERT INTO players (nick, total_kills, total_deaths, total_damage, last_kills, last_deaths, last_damage)
        VALUES ($1,$2,$3,$4,$2,$3,$4)
      `, [nick, kills, deaths, damage]);

    } else {
      const p = existing.rows[0];

      const isReset =
        kills < p.last_kills ||
        deaths < p.last_deaths ||
        damage < p.last_damage;

      const deltaKills = isReset ? kills : (kills - p.last_kills);
      const deltaDeaths = isReset ? deaths : (deaths - p.last_deaths);
      const deltaDamage = isReset ? damage : (damage - p.last_damage);

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

  console.log("✔ Veri güncellendi");
}

// PANEL
app.get("/", async (req, res) => {
  const result = await pool.query(`
    SELECT *,
    (total_kills - total_deaths) AS rank_score
    FROM players
    ORDER BY rank_score DESC
  `);

  let html = `
  <html>
  <body style="background:#000;color:#fff;font-family:Arial">
  <h1 style="text-align:center">RANK SİSTEMİ</h1>
  <table border="1" style="margin:auto;width:90%">
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

  html += "</table></body></html>";

  res.send(html);
});

// START
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("Server çalıştı:", PORT);

  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
