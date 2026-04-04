const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 🔥 TABLO OLUŞTUR (DOĞRU YAPI)
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        nick TEXT UNIQUE,
        total_score INT DEFAULT 0,
        last_score INT DEFAULT 0
      );
    `);
    console.log("DB hazır");
  } catch (err) {
    console.error("DB hata:", err.message);
  }
})();

// 🔥 ANA SİSTEM (DELTA MANTIK)
app.get("/rank", async (req, res) => {
  try {
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
        // yeni oyuncu
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
          // reset olmuş
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

    res.json({
      message: "delta sistem calisti",
      oyuncu: players.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

app.get("/", (req, res) => {
  res.send("server calisiyor");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server calisiyor:", PORT);
});
