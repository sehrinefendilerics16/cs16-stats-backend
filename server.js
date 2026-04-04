const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");

const app = express();

// 🔥 DB bağlantısı
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 🔥 tablo oluştur (ilk çalışmada)
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        nick TEXT UNIQUE,
        total_score INT DEFAULT 0
      );
    `);
    console.log("DB hazir");
  } catch (err) {
    console.error("DB hata:", err.message);
  }
})();

// 🔥 veri çek + DB’ye yaz
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

      const rank = $(tds[0]).text().trim();
      const nick = $(tds[1]).text().trim();
      const score = parseInt($(tds[2]).text().trim()) || 0;

      if (nick) {
        players.push({ rank, nick, score });
      }
    });

    // 🔥 DB’ye yaz (GEÇİCİ - hatalı mantık ama test için)
    for (let p of players) {
      await pool.query(
        `
        INSERT INTO players (nick, total_score)
        VALUES ($1, $2)
        ON CONFLICT (nick)
        DO UPDATE SET total_score = players.total_score + $2
        `,
        [p.nick, p.score]
      );
    }

    res.json({
      message: "veri yazildi (gecici sistem)",
      count: players.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Hata: " + err.message);
  }
});

// test endpoint
app.get("/", (req, res) => {
  res.send("SERVER CALISIYOR");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server calisiyor, port:", PORT);
});
