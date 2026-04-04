const express = require("express");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

app.use(express.json());

/*
  ANA SAYFA (UI)
*/
app.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM players
      ORDER BY total_score DESC, last_score DESC
    `);

    let html = `
    <html>
    <head>
      <title>CS 1.6 Rank</title>
      <style>
        body {
          background: #0d0d0d;
          color: #fff;
          font-family: Arial;
        }
        h1 {
          text-align: center;
        }
        table {
          width: 80%;
          margin: auto;
          border-collapse: collapse;
        }
        th, td {
          padding: 10px;
          border-bottom: 1px solid #333;
          text-align: center;
        }
        tr:hover {
          background: #1a1a1a;
        }
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

    result.rows.forEach((player, index) => {
      html += `
        <tr>
          <td>${index + 1}</td>
          <td>${player.nick}</td>
          <td>${player.total_score}</td>
          <td>${player.last_score}</td>
        </tr>
      `;
    });

    html += `
      </table>
    </body>
    </html>
    `;

    res.send(html);
  } catch (err) {
    res.send(err.message);
  }
});

/*
  TÜM OYUNCULAR (JSON)
*/
app.get("/players", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM players
      ORDER BY total_score DESC, last_score DESC
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/*
  SCORE UPDATE (PLUGIN BURAYA POST ATACAK)
*/
app.get("/rank", async (req, res) => {
  try {
    const nick = req.query.nick;
    const score = parseInt(req.query.score);

    if (!nick || isNaN(score)) {
      return res.send("hatalı veri");
    }

    const player = await pool.query(
      "SELECT * FROM players WHERE nick = $1",
      [nick]
    );

    if (player.rows.length === 0) {
      await pool.query(
        "INSERT INTO players (nick, total_score, last_score) VALUES ($1, $2, $3)",
        [nick, score, score]
      );
    } else {
      await pool.query(
        "UPDATE players SET total_score = total_score + $1, last_score = $1 WHERE nick = $2",
        [score, nick]
      );
    }

    res.send("veri güncellendi");
  } catch (err) {
    res.send(err.message);
  }
});

app.listen(port, () => {
  console.log("Server çalışıyor:", port);
});
