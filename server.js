const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// DB setup
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nick TEXT UNIQUE,
      total_score INT DEFAULT 0,
      last_score INT DEFAULT 0
    );
  `);

  await pool.query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS last_score INT DEFAULT 0;
  `);

  console.log("DB hazır");
})();

// VERİ ÇEK + KAYDET
app.get("/rank", async (req, res) => {
  const url =
    "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";

  const response = await axios.get(url);
  const html = response.data;

  const $ = cheerio.load(html);

  let players = [];

  $("table tbody tr").each((i, el) => {
    const tds = $(el).find("td");

    const nick = $(tds[1]).text().trim();
    const score = parseInt($(tds[2]).text().trim()) || 0;

    if (nick) {
      players.push({ nick, score });
    }
  });

  for (let p of players) {
    const result = await pool.query(
      "SELECT * FROM players WHERE nick = $1",
      [p.nick]
    );

    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO players (nick, total_score, last_score)
         VALUES ($1, $2, $2)`,
        [p.nick, p.score]
      );
    } else {
      const player = result.rows[0];

      let fark = 0;

      if (p.score >= player.last_score) {
        fark = p.score - player.last_score;
      } else {
        fark = p.score;
      }

      await pool.query(
        `UPDATE players
         SET total_score = total_score + $1,
             last_score = $2
         WHERE nick = $3`,
        [fark, p.score, p.nick]
      );
    }
  }

  res.send("veri güncellendi");
});

// 🔥 HTML TABLO (ASIL OLAY)
app.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM players ORDER BY total_score DESC LIMIT 50"
  );

  let html = `
  <html>
  <head>
    <title>CS 1.6 Rank</title>
    <style>
      body { background:#111; color:#fff; font-family:Arial; }
      table { width:80%; margin:auto; border-collapse:collapse; }
      th, td { padding:10px; border:1px solid #333; text-align:center; }
      th { background:#222; }
      tr:nth-child(even){ background:#1a1a1a; }
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
    </tr>
  `;

  result.rows.forEach((p, i) => {
    html += `
      <tr>
        <td>${i + 1}</td>
        <td>${p.nick}</td>
        <td>${p.total_score}</td>
      </tr>
    `;
  });

  html += `
    </table>
  </body>
  </html>
  `;

  res.send(html);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server çalışıyor:", PORT);
});
