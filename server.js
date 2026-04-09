const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BASE_URL = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";

let isRunning = false;
let cache = {};
const CACHE_LIMIT = 50;

// ================= 1. CACHE CLEAN =================
function cleanCache() {
  const now = Date.now();
  for (const key in cache) {
    if (now - cache[key].time > 30000) delete cache[key];
  }
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    const sorted = keys.sort((a, b) => cache[a].time - cache[b].time);
    sorted.slice(0, keys.length - CACHE_LIMIT).forEach(k => delete cache[k]);
  }
}

// ================= 2. XSS KORUMASI =================
function escapeHTML(str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[m]));
}

// ================= 3. VERİTABANI BAŞLATMA =================
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nick ON players (LOWER(nick));`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_log (
      id SERIAL PRIMARY KEY,
      last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_hash TEXT
    );
  `);
}

// ================= 4. SCRAPER =================
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
      const hsMatch = $(cols[3]).text().trim().match(/\((.*?)%\)/);
      const hsPercent = hsMatch ? parseFloat(hsMatch[1]) : 0;
      const deaths = parseInt($(cols[4]).text()) || 0;
      const accMatch = $(cols[6]).text().trim().match(/\((.*?)%\)/);
      const accuracy = accMatch ? parseFloat(accMatch[1]) : 0;
      const damage = parseInt($(cols[7]).text()) || 0;
      if (!nick || nick.includes("Toplam")) return;
      players.push({ nick, kills, deaths, damage, hsPercent, accuracy });
    });
    return players;
  } catch (err) {
    if (retry > 0) return fetchPlayers(retry - 1);
    throw err;
  }
}

function generateHash(players) {
  return crypto.createHash("md5").update(JSON.stringify(players)).digest("hex");
}

// ================= 5. ANA MOTOR =================
async function fetchAndSave() {
  if (isRunning) return;
  isRunning = true;
  const client = await pool.connect();
  try {
    const players = await fetchPlayers();
    if (!players || players.length < 5) {
      isRunning = false;
      setTimeout(fetchAndSave, 180000);
      return;
    }
    const newHash = generateHash(players);
    const lastHashRes = await client.query(`SELECT last_hash FROM system_log ORDER BY id DESC LIMIT 1`);
    const lastHash = lastHashRes.rows[0]?.last_hash;

    if (lastHash && lastHash === newHash) {
      await client.query(`INSERT INTO system_log (last_fetch, last_hash) VALUES (CURRENT_TIMESTAMP, $1)`, [newHash]);
      await client.query(`DELETE FROM system_log WHERE last_fetch < NOW() - INTERVAL '7 days'`);
      isRunning = false;
      setTimeout(fetchAndSave, 180000);
      return;
    }

    const all = await client.query(`SELECT nick, last_kills, last_deaths, last_damage, hs_percent, accuracy FROM players`);
    const map = new Map(all.rows.map(p => [p.nick, p]));
    await client.query('BEGIN');
    for (const p of players) {
      const old = map.get(p.nick);
      if (!old) {
        await client.query(`INSERT INTO players (nick,total_kills,total_deaths,total_damage,last_kills,last_deaths,last_damage,hs_percent,accuracy) VALUES ($1,$2,$3,$4,$2,$3,$4,$5,$6)`, [p.nick, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
        continue;
      }
      if (p.kills === old.last_kills && p.deaths === old.last_deaths && p.damage === old.last_damage && p.hsPercent === old.hs_percent && p.accuracy === old.accuracy) continue;
      const isReset = p.kills < old.last_kills || p.deaths < old.last_deaths || p.damage < old.last_damage;
      const dk = isReset ? p.kills : p.kills - old.last_kills;
      const dd = isReset ? p.deaths : p.deaths - old.last_deaths;
      const dmg = isReset ? p.damage : p.damage - old.last_damage;
      await client.query(`UPDATE players SET total_kills = total_kills + $2, total_deaths = total_deaths + $3, total_damage = total_damage + $4, last_kills = $5, last_deaths = $6, last_damage = $7, hs_percent = $8, accuracy = $9, updated_at = CURRENT_TIMESTAMP WHERE nick = $1`, [p.nick, dk, dd, dmg, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
    }
    await client.query(`INSERT INTO system_log (last_fetch, last_hash) VALUES (CURRENT_TIMESTAMP, $1)`, [newHash]);
    await client.query(`DELETE FROM system_log WHERE last_fetch < NOW() - INTERVAL '7 days'`);
    await client.query('COMMIT');
    cache = {}; 
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
  } finally {
    client.release();
    isRunning = false;
    setTimeout(fetchAndSave, 180000);
  }
}

// ================= 6. ROTALAR =================
let statusCache = { data: "", time: 0 };
app.get("/status", async (req, res) => {
  if (Date.now() - statusCache.time < 60000) return res.send(statusCache.data);
  try {
    const r = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
    const t = r.rows[0]?.last_fetch;
    const formatted = t ? new Date(t).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "Veri yok";
    const html = `<html><body style="background:#0f172a;color:white;font-family:Arial;text-align:center;padding-top:100px;"><h2>📊 Son Güncelleme</h2><h1>${formatted}</h1></body></html>`;
    statusCache = { data: html, time: Date.now() };
    res.send(html);
  } catch (err) { res.send("Hata..."); }
});

app.get("/force-update", async (req, res) => {
  await fetchAndSave();
  res.send("✅ Güncellendi!");
});

// ================= 7. OYUNCU PANELİ =================
app.get("/", async (req, res) => {
  const search = (req.query.search || "").toLowerCase();
  if (cache[search] && Date.now() - cache[search].time < 30000) return res.send(cache[search].data);
  const result = await pool.query(`SELECT *, (total_kills - total_deaths) AS puan, (total_kills::float / GREATEST(total_deaths,1)) AS kd FROM players WHERE LOWER(nick) LIKE $1`, [`%${search}%`]);
  let players = result.rows.map(p => {
    const activity = Math.min(p.total_kills / 1000, 1);
    const score = ((p.total_kills - p.total_deaths) * 1) + (p.kd * 2.5) + (p.hs_percent * 1.5) + (Math.min(p.accuracy, 35) * 0.3) + (p.total_damage / 800);
    return { ...p, score: score * (0.7 + activity * 0.3) };
  }).sort((a,b)=> b.score - a.score);
  const top3 = players.slice(0,3);

  let html = `
  <html>
  <head>
    <meta charset="UTF-8">
    <title>SEHRIN EFENDILERI - Sıralama</title>
    <style>
      body{background:#0f172a;color:white;font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;margin:0;padding-bottom:50px; overflow-x: hidden;}
      
      .header-container {text-align:center; padding: 40px 10px; background: #020617; width: 100%;}
      .main-title {
        font-size: clamp(24px, 5vw, 42px); font-weight: 900; letter-spacing: 3px; margin: 0;
        text-shadow: 0 0 15px rgba(56, 189, 248, 0.5);
      }
      .ip-title { color: #38bdf8; font-size: clamp(18px, 3vw, 26px); margin-top: 10px; font-weight: 600; }

      .content-wrapper { width: 95%; max-width: 1400px; margin: 0 auto; }

      .top{display:flex;justify-content:center;gap:20px;margin:30px 0;flex-wrap:wrap;}
      .box{padding:15px 30px;border-radius:12px;font-weight:bold;box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); min-width: 200px; text-align:center;}
      .g{background:linear-gradient(135deg, #facc15, #ca8a04);color:#000}
      .s{background:linear-gradient(135deg, #e2e8f0, #94a3b8);color:#000}
      .b{background:linear-gradient(135deg, #fb923c, #c2410c);color:#000}
      
      .info-box {text-align:center; background:#1e293b; border: 1px solid #334155; padding: 15px; margin: 20px auto; width: 100%; max-width: 800px; border-radius: 8px; color:#cbd5e1; font-size: 15px;}
      
      .search{text-align:center;margin:30px 0}
      input{padding:14px 20px;border-radius:8px;border:1px solid #334155; width: clamp(200px, 50%, 400px); outline:none;background:#1e293b;color:white; font-size: 16px;}
      button{padding:14px 30px;border-radius:8px;border:none;background:#38bdf8;cursor:pointer;font-weight:bold;color:white;transition:0.3s; font-size: 16px;}
      button:hover{background:#0284c7; transform: translateY(-2px);}
      
      .ig-link{text-align:center; margin: 20px 0;}
      .ig-link a{color:#e1306c;text-decoration:none;font-weight:bold;background:#020617;padding:12px 30px;border-radius:8px;display:inline-block;border: 1px solid #e1306c; transition:0.3s;}
      .ig-link a:hover{background:#e1306c;color:white;}

      .table-container { width: 100%; overflow-x: auto; background: #0f172a; border-radius:12px; box-shadow: 0 0 30px rgba(0,0,0,0.5); }
      table{width: 100%; border-collapse:collapse; min-width: 900px;}
      th{background:#1e293b;padding:20px 10px;text-align:center;font-size:14px;text-transform:uppercase;color:#94a3b8; letter-spacing: 1px;}
      td{padding:18px 10px;text-align:center;border-bottom:1px solid #1e293b;font-size:16px;position:relative;transition:0.2s;}
      
      /* NİCK RENGİ GÜNCELLEMESİ */
      .player-nick { color: #38bdf8; font-weight: 600; }

      tr:hover td { background: rgba(56, 189, 248, 0.12); }
      tr:hover .player-nick { color: #fff; } /* Üzerine gelince nick beyaza dönsün ki parlasın */
      
      tr:hover td:first-child::before {
        content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: #38bdf8;
      }

      b { font-weight: 700; }
    </style>
  </head>
  <body>
    <div class="header-container">
      <h1 class="main-title">SEHRIN EFENDILERI</h1>
      <div class="ip-title">(95.173.173.81)</div>
    </div>

    <div class="content-wrapper">
        <div class="ig-link">
          <a href="https://instagram.com/sehrinefendilerics16" target="_blank">📷 Instagram: @sehrinefendilerics16</a>
        </div>

        <div class="info-box">
          ⚠️ Tüm veriler 30.03.2026 tarihinden itibaren kaydedilmektedir.
        </div>

        <div class="top">
          <div class="box g">🥇 ${top3[0] ? escapeHTML(top3[0].nick) : "---"}</div>
          <div class="box s">🥈 ${top3[1] ? escapeHTML(top3[1].nick) : "---"}</div>
          <div class="box b">🥉 ${top3[2] ? escapeHTML(top3[2].nick) : "---"}</div>
        </div>

        <form class="search">
          <input name="search" placeholder="Oyuncu adını yaz..." value="${escapeHTML(search)}">
          <button type="submit">Ara</button>
        </form>

        <div class="table-container">
            <table>
              <tr><th>SIRA</th><th>NICK</th><th>ÖLDÜRME</th><th>ÖLÜM</th><th>K/D</th><th>HASAR</th><th>SKOR</th></tr>
              ${players.map((p,i)=>`
                <tr>
                  <td><b>${i+1}</b></td>
                  <td class="player-nick">${escapeHTML(p.nick)}</td>
                  <td>${p.total_kills}</td>
                  <td>${p.total_deaths}</td>
                  <td>${p.kd.toFixed(2)}</td>
                  <td>${p.total_damage}</td>
                  <td><b style="color:#38bdf8;">${Math.round(p.score)}</b></td>
                </tr>
              `).join('')}
            </table>
        </div>
    </div>
  </body>
  </html>`;
  cache[search] = { data: html, time: Date.now() };
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  await fetchAndSave();
  setInterval(cleanCache, 60000);
  console.log(`Sistem Aktif: ${PORT}`);
});
