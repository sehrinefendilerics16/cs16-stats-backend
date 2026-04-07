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

let isRunning = false;
let cache = {};

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
      hs_percent FLOAT DEFAULT 0,
      accuracy FLOAT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS hs_percent FLOAT DEFAULT 0`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS accuracy FLOAT DEFAULT 0`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_log (
      id SERIAL PRIMARY KEY,
      last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ================= SCRAPER =================
async function fetchPlayers(retry = 2) {
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 5000 });

    const $ = cheerio.load(data);
    const players = [];

    $("table.CSS_Table_Example tr").each((i, row) => {
      if (i === 0) return;

      const cols = $(row).find("td");
      if (cols.length !== 8) return;

      const nick = $(cols[1]).text().trim();
      const kills = parseInt($(cols[2]).text()) || 0;

      const hsText = $(cols[3]).text().trim();
      const hsMatch = hsText.match(/\((.*?)%\)/);
      const hsPercent = hsMatch ? parseFloat(hsMatch[1]) : 0;

      const deaths = parseInt($(cols[4]).text()) || 0;

      const accText = $(cols[6]).text().trim();
      const accMatch = accText.match(/\((.*?)%\)/);
      const accuracy = accMatch ? parseFloat(accMatch[1]) : 0;

      const damage = parseInt($(cols[7]).text()) || 0;

      if (!nick || nick.includes("Toplam")) return;

      players.push({ nick, kills, deaths, damage, hsPercent, accuracy });
    });

    return players;

  } catch (err) {
    if (retry > 0) {
      console.log("⚠️ Retry...");
      return fetchPlayers(retry - 1);
    }
    throw err;
  }
}

// ================= CORE =================
async function fetchAndSave() {

  if (isRunning) return;
  isRunning = true;

  try {
    const players = await fetchPlayers();

    if (!players || players.length < 5) return;

    const all = await pool.query(`SELECT * FROM players`);
    const map = new Map(all.rows.map(p => [p.nick, p]));

    for (const p of players) {
      const old = map.get(p.nick);

      if (!old) {
        await pool.query(`
          INSERT INTO players 
          (nick,total_kills,total_deaths,total_damage,last_kills,last_deaths,last_damage,hs_percent,accuracy)
          VALUES ($1,$2,$3,$4,$2,$3,$4,$5,$6)
        `, [p.nick, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
        continue;
      }

      if (
        p.kills === old.last_kills &&
        p.deaths === old.last_deaths &&
        p.damage === old.last_damage
      ) continue;

      const isReset =
        p.kills < old.last_kills ||
        p.deaths < old.last_deaths ||
        p.damage < old.last_damage;

      const dk = isReset ? p.kills : p.kills - old.last_kills;
      const dd = isReset ? p.deaths : p.deaths - old.last_deaths;
      const dmg = isReset ? p.damage : p.damage - old.last_damage;

      await pool.query(`
        UPDATE players SET
          total_kills = total_kills + $2,
          total_deaths = total_deaths + $3,
          total_damage = total_damage + $4,
          last_kills = $5,
          last_deaths = $6,
          last_damage = $7,
          hs_percent = $8,
          accuracy = $9,
          updated_at = CURRENT_TIMESTAMP
        WHERE nick = $1
      `, [p.nick, dk, dd, dmg, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
    }

    await pool.query(`INSERT INTO system_log (last_fetch) VALUES (CURRENT_TIMESTAMP)`);

    cache = {}; // 🔥 CACHE RESET (KRİTİK)

  } catch (err) {
    console.error("❌", err.message);
  } finally {
    isRunning = false;
  }
}

// ================= ROUTES =================
app.get("/force-update", async (req, res) => {
  await fetchAndSave();
  res.send("Manuel veri çekildi ✔");
});

app.get("/status", async (req, res) => {
  const result = await pool.query(`
    SELECT last_fetch FROM system_log
    ORDER BY id DESC
    LIMIT 1
  `);

  const last = result.rows[0];

  res.send(`
    <h2>Son Veri Çekim Zamanı</h2>
    <p>${last ? last.last_fetch : "Henüz veri yok"}</p>
  `);
});

// ================= PANEL =================
app.get("/", async (req, res) => {

  const search = req.query.search || "";

  if (
    cache[search] &&
    Date.now() - cache[search].time < 30000
  ) {
    return res.send(cache[search].data);
  }

  const result = await pool.query(`
    SELECT *,
      (total_kills - total_deaths) AS puan,
      (total_kills::float / GREATEST(total_deaths,1)) AS kd
    FROM players
    WHERE LOWER(nick) LIKE LOWER($1)
  `, [`%${search}%`]);

  let players = result.rows;

  players = players.map(p => {
    const kd = p.kd || 0;
    const hs = p.hs_percent || 0;
    const acc = p.accuracy || 0;

    const activity = Math.min(p.total_kills / 50, 1);

    const score =
      ((p.total_kills - p.total_deaths) * 0.5) +
      (kd * 15) +
      (hs * 1.5) +
      (acc * 1.2);

    return { ...p, score: score * activity };
  });

  players.sort((a,b)=> b.score - a.score);

  const top3 = players.slice(0,3);

  let html = `...`; // (senin HTML aynen kalıyor)

  players.forEach((p,i)=>{
    const kd = p.kd.toFixed(2);

    html+=`
    <tr>
      <td>${i+1}</td>
      <td>${p.nick}</td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td class="${kd>=2?'good':kd<1?'bad':''}">${kd}</td>
      <td>${p.total_damage}</td>
      <td>${Math.round(p.score)}</td>
    </tr>`;
  });

  html+=`</table></body></html>`;

  cache[search] = { data: html, time: Date.now() };

  res.send(html);
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await initDB();
  await fetchAndSave();
  setInterval(fetchAndSave, 60000);
});
