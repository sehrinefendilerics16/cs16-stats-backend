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

// ================= DB =================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      nick TEXT UNIQUE,
      total_kills INT DEFAULT 0,
      total_deaths INT DEFAULT 0,
      total_damage INT DEFAULT 0,
      last_kills INT DEFAULT 0,
      last_deaths INT DEFAULT 0,
      last_damage INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_history (
      id SERIAL PRIMARY KEY,
      nick TEXT,
      kills INT,
      deaths INT,
      damage INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ================= SCRAPE =================
async function fetchPlayers() {
  const { data } = await axios.get(BASE_URL);
  const $ = cheerio.load(data);

  const players = [];

  $("table.CSS_Table_Example tr").each((i, row) => {
    if (i === 0) return;

    const cols = $(row).find("td");
    if (cols.length !== 8) return;

    const nick = $(cols[1]).text().trim();
    const kills = parseInt($(cols[2]).text()) || 0;
    const deaths = parseInt($(cols[4]).text()) || 0;
    const damage = parseInt($(cols[7]).text()) || 0;

    if (!nick || nick.includes("Toplam")) return;

    players.push({ nick, kills, deaths, damage });
  });

  return players;
}

// ================= UPDATE =================
async function fetchAndSave() {
  const players = await fetchPlayers();

  for (const p of players) {
    const res = await pool.query("SELECT * FROM players WHERE nick=$1", [p.nick]);

    if (res.rows.length === 0) {
      await pool.query(`
        INSERT INTO players (nick,total_kills,total_deaths,total_damage,last_kills,last_deaths,last_damage)
        VALUES ($1,$2,$3,$4,$2,$3,$4)
      `, [p.nick, p.kills, p.deaths, p.damage]);
    } else {
      const old = res.rows[0];

      await pool.query(`
        UPDATE players SET
          total_kills = total_kills + ($2 - last_kills),
          total_deaths = total_deaths + ($3 - last_deaths),
          total_damage = total_damage + ($4 - last_damage),
          last_kills = $2,
          last_deaths = $3,
          last_damage = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE nick = $1
      `, [p.nick, p.kills, p.deaths, p.damage]);
    }

    if (new Date().getMinutes() % 5 === 0) {
      await pool.query(`
        INSERT INTO player_history (nick,kills,deaths,damage)
        VALUES ($1,$2,$3,$4)
      `, [p.nick, p.kills, p.deaths, p.damage]);
    }
  }
}

// ================= ANA SAYFA =================
app.get("/", async (req, res) => {

  const result = await pool.query(`
    SELECT *, (total_kills-total_deaths) AS puan
    FROM players ORDER BY puan DESC
  `);

  const players = result.rows;
  const top3 = players.slice(0,3);

  let html = `
  <html><head><style>
  body{background:#0f172a;color:white;font-family:Arial;margin:0}
  h1{text-align:center;padding:20px;background:#020617;margin:0}
  .top{display:flex;justify-content:center;gap:20px;margin:20px}
  .box{padding:15px 25px;border-radius:10px;font-weight:bold}
  .g{background:#facc15;color:black}
  .s{background:#cbd5f5;color:black}
  .b{background:#fb923c;color:black}
  table{width:95%;margin:auto;border-collapse:collapse}
  th{background:#1e293b;padding:10px}
  td{padding:8px;text-align:center;border-bottom:1px solid #334155}
  a{color:#38bdf8;text-decoration:none}
  </style></head><body>

  <h1>SEHRIN EFENDILERI</h1>

  <div class="top">
    <div class="box g">🥇 ${top3[0]?.nick||""}</div>
    <div class="box s">🥈 ${top3[1]?.nick||""}</div>
    <div class="box b">🥉 ${top3[2]?.nick||""}</div>
  </div>

  <table>
  <tr>
    <th>#</th>
    <th>Oyuncu</th>
    <th>Öldürme</th>
    <th>Ölüm</th>
    <th>K/D</th>
    <th>Hasar</th>
    <th>Puan</th>
  </tr>
  `;

  players.forEach((p,i)=>{
    const kd = (p.total_kills/(p.total_deaths||1)).toFixed(2);

    html+=`
    <tr>
      <td>${i+1}</td>
      <td><a href="/player/${encodeURIComponent(p.nick)}">${p.nick}</a></td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td>${kd}</td>
      <td>${p.total_damage}</td>
      <td>${p.puan}</td>
    </tr>`;
  });

  html+=`</table></body></html>`;
  res.send(html);
});

// ================= PROFİL =================
app.get("/player/:nick", async (req, res) => {

  const nick = decodeURIComponent(req.params.nick);

  const p = (await pool.query("SELECT * FROM players WHERE nick=$1",[nick])).rows[0];
  const history = (await pool.query("SELECT * FROM player_history WHERE nick=$1 ORDER BY created_at",[nick])).rows;

  if (!p) return res.send("Oyuncu yok");

  const kd = (p.total_kills/(p.total_deaths||1)).toFixed(2);

  res.send(`
  <html>
  <head>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
  body{background:#0f172a;color:white;font-family:Arial}
  .box{background:#1e293b;padding:15px;border-radius:10px;margin:10px}
  </style>
  </head>
  <body>

  <h1>${nick}</h1>

  <div class="box">Kill: ${p.total_kills}</div>
  <div class="box">Death: ${p.total_deaths}</div>
  <div class="box">K/D: ${kd}</div>

  <canvas id="c"></canvas>

  <script>
  const data = ${JSON.stringify(history)};
  new Chart(document.getElementById("c"),{
    type:"line",
    data:{
      labels:data.map(x=>new Date(x.created_at).toLocaleTimeString()),
      datasets:[
        {label:"Kill",data:data.map(x=>x.kills),borderColor:"green"},
        {label:"Death",data:data.map(x=>x.deaths),borderColor:"red"},
        {label:"Damage",data:data.map(x=>x.damage),borderColor:"orange"}
      ]
    }
  })
  </script>

  </body></html>
  `);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await initDB();
  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
