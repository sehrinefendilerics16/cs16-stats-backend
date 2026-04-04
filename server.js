const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

app.get("/rank", async (req, res) => {
  try {
    const response = await axios.get("PANEL_URL_BURAYA");

    const html = response.data;
    const $ = cheerio.load(html);

    let players = [];

    $("table tbody tr").each((i, el) => {
      const rank = $(el).find("td").eq(0).text().trim();
      const nick = $(el).find("td").eq(1).text().trim();
      const score = $(el).find("td").eq(2).text().trim();

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
