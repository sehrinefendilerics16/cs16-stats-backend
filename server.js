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

    let rows = "";

    $("table tbody tr").each((i, el) => {
      const tds = $(el).find("td");

      const rank = $(tds[0]).text().trim();
      const nick = $(tds[1]).text().trim();
      const score = $(tds[2]).text().trim();

      rows += `
        <tr>
          <td>${rank}</td>
          <td>${nick}</td>
          <td>${score}</td>
        </tr>
      `;
    });

    res.send(`
      <html>
      <head>
        <title>CS 1.6 Rank</title>
        <style>
          body { font-family: Arial; background: #111; color: #fff; }
          table { width: 80%; margin: auto; border-collapse: collapse; }
          th, td { padding: 10px; border: 1px solid #444; text-align: center; }
          th { background: #222; }
        </style>
      </head>
      <body>
        <h2 style="text-align:center;">CS 1.6 Rank Listesi</h2>
        <table>
          <tr>
            <th>Sıra</th>
            <th>Oyuncu</th>
            <th>Puan</th>
          </tr>
          ${rows}
        </table>
      </body>
      </html>
    `);

  } catch (err) {
    res.status(500).send("Hata: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server calisiyor, port:", PORT);
});
