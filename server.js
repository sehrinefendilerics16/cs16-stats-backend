const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

app.get("/rank", async (req, res) => {
  try {
    const url = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";

    const response = await axios.get(url);
    const html = response.data;

    const $ = cheerio.load(html);

    let players = [];

    $("table tbody tr").each((i, el) => {
      const tds = $(el).find("td");

      const rank = $(tds[0]).text().trim();
      const nick = $(tds[1]).text().trim();
      const score = $(tds[2]).text().trim();

      players.push({ rank, nick, score });
    });

    res.json(players);
  } catch (err) {
    res.status(500).send("Hata: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server calisiyor, port:", PORT);
});
