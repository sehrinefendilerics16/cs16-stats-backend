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

// ================= 1. CACHE CLEAN (Bellek Şişmesini Önler) =================
function cleanCache() {
  const now = Date.now();
  for (const key in cache) {
    if (now - cache[key].time > 30000) {
      delete cache[key];
    }
  }
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    const sorted = keys.sort((a, b) => cache[a].time - cache[b].time);
    const toDelete = sorted.slice(0, keys.length - CACHE_LIMIT);
    toDelete.forEach(k => delete cache[k]);
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

// ================= 4. SCRAPER (Oyunyöneticisinden Veri Çekme) =================
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

// ================= 5. ANA MOTOR (Kümülatif, Akıllı ve İşlem Korumalı) =================
async function fetchAndSave() {
  if (isRunning) return;
  isRunning = true;

  // 🔥 YENİLİK 1: Veritabanını yormamak için özel bağlantı açıyoruz
  const client = await pool.connect();

  try {
    const players = await fetchPlayers();
    if (!players || players.length < 5) {
      isRunning = false;
      setTimeout(fetchAndSave, 180000); // Hata varsa 3 dk sonra tekrar dene
      return;
    }

    const newHash = generateHash(players);
    const lastHashRes = await client.query(`SELECT last_hash FROM system_log ORDER BY id DESC LIMIT 1`);
    const lastHash = lastHashRes.rows[0]?.last_hash;

    if (lastHash && lastHash === newHash) {
      await client.query(`INSERT INTO system_log (last_fetch, last_hash) VALUES (CURRENT_TIMESTAMP, $1)`, [newHash]);
      await client.query(`DELETE FROM system_log WHERE last_fetch < NOW() - INTERVAL '7 days'`);
      isRunning = false;
      setTimeout(fetchAndSave, 180000); // Veri aynıysa 3 dk bekle tekrar dene
      return;
    }

    const all = await client.query(`SELECT nick, last_kills, last_deaths, last_damage, hs_percent, accuracy FROM players`);
    const map = new Map(all.rows.map(p => [p.nick, p]));

    // 🔥 YENİLİK 2: TRANSACTION BAŞLANGICI (Tüm oyuncuları tek pakette kaydeder, hızlandırır)
    await client.query('BEGIN');

    for (const p of players) {
      const old = map.get(p.nick);

      if (!old) {
        await client.query(`
          INSERT INTO players (nick,total_kills,total_deaths,total_damage,last_kills,last_deaths,last_damage,hs_percent,accuracy)
          VALUES ($1,$2,$3,$4,$2,$3,$4,$5,$6)
        `, [p.nick, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
        continue;
      }

      if (
        p.kills === old.last_kills && p.deaths === old.last_deaths && p.damage === old.last_damage &&
        p.hsPercent === old.hs_percent && p.accuracy === old.accuracy
      ) continue;

      if (p.kills === old.last_kills && p.deaths === old.last_deaths && p.damage === old.last_damage) {
        await client.query(`
          UPDATE players SET hs_percent = $2, accuracy = $3, updated_at = CURRENT_TIMESTAMP WHERE nick = $1
        `, [p.nick, p.hsPercent, p.accuracy]);
        continue;
      }

      // Delta Hesaplama (Asla Veri Kaybetmez)
      const isReset = p.kills < old.last_kills || p.deaths < old.last_deaths || p.damage < old.last_damage;
      const dk = isReset ? p.kills : p.kills - old.last_kills;
      const dd = isReset ? p.deaths : p.deaths - old.last_deaths;
      const dmg = isReset ? p.damage : p.damage - old.last_damage;

      await client.query(`
        UPDATE players SET
          total_kills = total_kills + $2,
          total_deaths = total_deaths + $3,
          total_damage = total_damage + $4,
          last_kills = $5, last_deaths = $6, last_damage = $7,
          hs_percent = $8, accuracy = $9, updated_at = CURRENT_TIMESTAMP
        WHERE nick = $1
      `, [p.nick, dk, dd, dmg, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
    }

    await client.query(`INSERT INTO system_log (last_fetch, last_hash) VALUES (CURRENT_TIMESTAMP, $1)`, [newHash]);
    await client.query(`DELETE FROM system_log WHERE last_fetch < NOW() - INTERVAL '7 days'`);
    
    // İşlemleri Onayla ve Kaydet
    await client.query('COMMIT');
    cache = {}; 

  } catch (err) {
    await client.query('ROLLBACK'); // Hata olursa sistemi geri al, veriyi koru
    console.error(err.message);
  } finally {
    client.release(); // Bağlantıyı kapat
    isRunning = false;
    // 🔥 YENİLİK 3: ZİNCİRLEME DÖNGÜ (Üst üste binmeyi %100 engeller)
    setTimeout(fetchAndSave, 180000); 
  }
}

// ================= 6. YÖNETİM ROTALARI =================

// 🔥 YENİLİK 4: UptimeRobot/Cron-job için Veritabanı Kalkanı
let statusCache = { data: "", time: 0 };

app.get("/status", async (req, res) => {
  // Botlar 5 dakikada bir gelse de, 60 saniyelik bu kalkan sayesinde DB yorulmaz
  if (Date.now() - statusCache.time < 60000) {
    return res.send(statusCache.data);
  }

  try {
    const r = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
    const t = r.rows[0]?.last_fetch;
    const formatted = t ? new Date(t).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "Veri yok";
    
    const html = `
    <html><body style="background:#0f172a;color:white;font-family:Arial;text-align:center;padding-top:100px;">
      <h2>📊 Son Güncelleme</h2><h1>${formatted}</h1>
    </body></html>
    `;

    statusCache = { data: html, time: Date.now() };
    res.send(html);
  } catch (err) {
    res.send("Veritabanı kontrol ediliyor...");
  }
});

app.get("/force-update", async (req, res) => {
  await fetchAndSave();
  res.send(`
  <html><body style="background:#0f172a;color:white;text-align:center;padding-top:100px;">
    <h2>✅ Veri Başarıyla Çekildi ve Güncellendi!</h2>
  </body></html>
  `);
});

// ================= 7. OYUNCU PANELİ (Ana Sayfa) =================
app.get("/", async (req, res) => {
  const search = (req.query.search || "").toLowerCase();

  if (cache[search] && Date.now() - cache[search].time < 30000) {
    return res.send(cache[search].data);
  }

  const result = await pool.query(`
    SELECT *,
      (total_kills - total_deaths) AS puan,
      (total_kills::float / GREATEST(total_deaths,1)) AS kd
    FROM players
    WHERE LOWER(nick) LIKE $1
  `, [`%${search}%`]);

  let players = result.rows;

  players = players.map(p => {
    const kd = p.kd || 0;
    const hs = p.hs_percent || 0;
    const acc = p.accuracy || 0;
    const dmg = p.total_damage || 0;

    const activity = Math.min(p.total_kills / 1000, 1);
    const accSafe = Math.min(acc, 35);

    const score = ((p.total_kills - p.total_deaths) * 1) + (kd * 2.5) + (hs * 1.5) + (accSafe * 0.3) + (dmg / 800);
    return { ...p, score: score * (0.7 + activity * 0.3) };
  });

  players.sort((a,b)=> b.score - a.score);
  const top3 = players.slice(0,3);

  let html = `
  <html>
  <head>
  <meta charset="UTF-8">
  <title>SEHRIN EFENDILERI - İstatistik ve Sıralama</title>
  <style>
  body{background:#0f172a;color:white;font-family:Arial, sans-serif;margin:0;padding-bottom:50px;}
  h1{text-align:center;padding:20px;background:#020617;margin:0;letter-spacing:2px;}
  .top{display:flex;justify-content:center;gap:20px;margin:20px;flex-wrap:wrap;}
  .box{padding:15px 25px;border-radius:10px;font-weight:bold;box-shadow: 0 4px 6px rgba(0,0,0,0.3);}
  .g{background:linear-gradient(135deg, #facc15, #ca8a04);color:black}
  .s{background:linear-gradient(135deg, #cbd5f5, #94a3b8);color:black}
  .b{background:linear-gradient(135deg, #fb923c, #c2410c);color:black}
  .search{text-align:center;margin:15px}
  input{padding:12px;border-radius:8px;border:none;width:250px;outline:none;}
  button{padding:12px 20px;border-radius:8px;border:none;background:#38bdf8;cursor:pointer;font-weight:bold;color:white;transition:0.3s;}
  button:hover{background:#0284c7;}
  .info{text-align:center;color:#94a3b8;margin-top:10px;font-size:14px;}
  .ig-link{text-align:center;margin-top:20px;margin-bottom:15px;}
  .ig-link a{color:#e1306c;text-decoration:none;font-weight:bold;font-size:16px;background:#020617;padding:12px 25px;border-radius:8px;display:inline-block;border: 1px solid #e1306c; transition:0.3s;}
  .ig-link a:hover{background:#e1306c;color:white;}
  table{width:95%;max-width:1200px;margin:20px auto;border-collapse:collapse;box-shadow: 0 0 20px rgba(0,0,0,0.5);}
  th{background:#1e293b;padding:12px;font-weight:bold;letter-spacing:1px;}
  td{padding:10px;text-align:center;border-bottom:1px solid #334155;}
  tr:hover td{background:#1e293b;}
  </style>
  </head>
  <body>
  <h1>SEHRIN EFENDILERI (95.173.173.81)</h1>
  <div class="ig-link">
    <a href="https://instagram.com/sehrinefendilerics16" target="_blank">📷 Instagram'da Bizi Takip Edin: @sehrinefendilerics16</a>
  </div>
  <div class="info">
    ⚠️ Sıralama verileri sürekli ve birikimli olarak hesaplanmaktadır. Sıfırlanmaz!
  </div>
  <div class="top">
    <div class="box g">🥇 ${top3[0] ? escapeHTML(top3[0].nick) : "Bekleniyor"}</div>
    <div class="box s">🥈 ${top3[1] ? escapeHTML(top3[1].nick) : "Bekleniyor"}</div>
    <div class="box b">🥉 ${top3[2] ? escapeHTML(top3[2].nick) : "Bekleniyor"}</div>
  </div>
  <form class="search">
    <input name="search" placeholder="Oyuncu ara..." value="${escapeHTML(search)}">
    <button type="submit">Ara</button>
  </form>
  <table>
  <tr><th>SIRA</th><th>NICK</th><th>ÖLDÜRME</th><th>ÖLÜM</th><th>K/D ORANI</th><th>HASAR</th><th>SKOR</th></tr>
  `;

  players.forEach((p,i)=>{
    html+=`
    <tr>
      <td><b>${i+1}</b></td>
      <td>${escapeHTML(p.nick)}</td>
      <td>${p.total_kills}</td>
      <td>${p.total_deaths}</td>
      <td>${p.kd.toFixed(2)}</td>
      <td>${p.total_damage}</td>
      <td><b style="color:#38bdf8;">${Math.round(p.score)}</b></td>
    </tr>`;
  });

  html+=`</table></body></html>`;
  cache[search] = { data: html, time: Date.now() };
  res.send(html);
});

// ================= 8. SUNUCUYU BAŞLAT =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await initDB();       
  await fetchAndSave(); // İlk açılışı yapar ve zincirleme (setTimeout) döngüsünü başlatır.
  
  setInterval(cleanCache, 60000); // Sadece RAM temizliğini bağımsız olarak dakikada bir yapar.
  console.log(`Sunucu ${PORT} portunda başarıyla çalışıyor. Sistem aktif!`);
});
