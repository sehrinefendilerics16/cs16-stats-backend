const express = require("express");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ANA SAYFA
app.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        nick,
        total_score,
        COALESCE(last_score, 0) as last_score
      FROM players
      WHERE total_score > 0
      AND length(nick) > 2
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

// DB FIX (GEÇİCİ)
app.get("/fix-db", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE players
      ADD COLUMN IF NOT EXISTS last_score INTEGER DEFAULT 0;
    `);

    res.send("DB düzeltildi");
  } catch (err) {
    res.send(err.message);
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server çalışıyor:", PORT);
});
