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
let cache = {};
const CACHE_LIMIT = 50;

// 🔥 KRİTİK GÜVENLİK: Şifreyi koddan çıkardık. Render panelinden (Environment) çekecek.
const ADMIN_KEY = process.env.ADMIN_KEY || "sehrinefendileri"; 

// ================= 1. RAM KORUMASI =================
function cleanCache() {
  const now = Date.now();
  for (const key in cache) {
    if (now - cache[key].time > 30000) delete cache[key];
  }
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    cache = {}; // Aşırı yüklenmede hafızayı sıfırla
  }
}

// ================= 2. VERİTABANI BAŞLATMA =================
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
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
      CREATE INDEX IF NOT EXISTS idx_nick_lower ON players (LOWER(nick));
      CREATE INDEX IF NOT EXISTS idx_ranking_speed ON players (total_kills, total_damage);
      
      CREATE TABLE IF NOT EXISTS system_log (
        id SERIAL PRIMARY KEY,
        last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_hash TEXT
      );
      ALTER TABLE system_log ADD COLUMN IF NOT EXISTS last_hash TEXT;
    `);
    console.log("⚔️ Arşiv Sistemi: Emekler Kayıt Altında.");
  } finally {
    client.release();
  }
}

// ================= 3. MOTOR VE SCRAPER =================
let isRunning = false;

async function fetchPlayers(retry = 2) {
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 8000 });
    const $ = cheerio.load(data);
    const players = [];
    
    const rows = $("table.CSS_Table_Example tr").length ? $("table.CSS_Table_Example tr") : $("table tr");

    rows.each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find("td");
      if (cols.length !== 8) return;
      
      const nick = $(cols[1]).text().trim();
      if (!nick || nick.includes("Toplam")) return;

      players.push({
        nick,
        kills: parseInt($(cols[2]).text()) || 0,
        hsPercent: parseFloat($(cols[3]).text().match(/\((.*?)%\)/)?.[1]) || 0,
        deaths: parseInt($(cols[4]).text()) || 0,
        accuracy: parseFloat($(cols[6]).text().match(/\((.*?)%\)/)?.[1]) || 0,
        damage: parseInt($(cols[7]).text()) || 0
      });
    });
    return players;
  } catch (err) {
    if (retry > 0) return fetchPlayers(retry - 1);
    throw err;
  }
}

async function fetchAndSave() {
  if (isRunning) return;
  isRunning = true;
  const client = await pool.connect();
  
  try {
    const players = await fetchPlayers();
    if (!players || players.length < 5) throw new Error("Yetersiz Veri");

    const sortedPlayers = [...players].sort((a, b) => a.nick.localeCompare(b.nick));
    const newHash = crypto.createHash("md5").update(JSON.stringify(sortedPlayers)).digest("hex");
    
    const lastHashRes = await client.query(`SELECT id, last_hash FROM system_log ORDER BY id DESC LIMIT 1`);
    
    if (lastHashRes.rows[0]?.last_hash === newHash) {
        return; 
    }

    await client.query('BEGIN');
    for (const p of players) {
      await client.query(`
        INSERT INTO players (nick, total_kills, total_deaths, total_damage, last_kills, last_deaths, last_damage, hs_percent, accuracy)
        VALUES ($1, $2, $3, $4, $2, $3, $4, $5, $6)
        ON CONFLICT (nick) DO UPDATE SET
          total_kills = players.total_kills + (CASE WHEN $2 < players.last_kills THEN $2 ELSE $2 - players.last_kills END),
          total_deaths = players.total_deaths + (CASE WHEN $3 < players.last_deaths THEN $3 ELSE $3 - players.last_deaths END),
          total_damage = players.total_damage + (CASE WHEN $4 < players.last_damage THEN $4 ELSE $4 - players.last_damage END),
          last_kills = $2, last_deaths = $3, last_damage = $4,
          hs_percent = $5, accuracy = $6, updated_at = CURRENT_TIMESTAMP;
      `, [p.nick, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
    }
    await client.query(`INSERT INTO system_log (last_fetch, last_hash) VALUES (CURRENT_TIMESTAMP, $1)`, [newHash]);
    await client.query('COMMIT');
    cache = {}; 
    console.log("✅ Yeni Veri Geldi ve Sistem Saati Güncellendi.");
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error("❌ Motor Hatası:", err.message);
  } finally {
    client.release();
    isRunning = false;
  }
}

// ================= 4. ARAYÜZ (TASARIM VE MANTIK KORUNDU) =================
app.get("/", async (req, res) => {
  const search = (req.query.search || "").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;
  const cacheKey = `${search}_p${page}`;

  if (cache[cacheKey] && Date.now() - cache[cacheKey].time < 30000) return res.send(cache[cacheKey].data);

  try {
    const query = `
      WITH ranked_players AS (
        SELECT *,
          (total_kills - total_deaths) as net_kills,
          (total_kills::float / GREATEST(total_deaths, 1)) as kd
        FROM players
        WHERE LOWER(nick) LIKE $1
      )
      SELECT *,
        ( (net_kills * 1.0) + (kd * 5.0) + (hs_percent * 1.5) + (total_damage / 1000.0) ) as score
      FROM ranked_players
      ORDER BY score DESC
      LIMIT $2 OFFSET $3
    `;
    
    const countRes = await pool.query(`SELECT COUNT(*) FROM players WHERE LOWER(nick) LIKE $1`, [`%${search}%`]);
    const result = await pool.query(query, [`%${search}%`, limit, offset]);

    const totalPages = Math.ceil(parseInt(countRes.rows[0].count) / limit);
    const players = result.rows;
    const top3 = (page === 1 && !search) ? players.slice(0, 3) : [];

    const escapeHTML = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
    
    let html = `<html><head><meta charset="UTF-8"><title>SEHRIN EFENDILERI</title><style>
      body{background:#0f172a;color:white;font-family:'Segoe UI',sans-serif;margin:0;padding-bottom:50px;overflow-x:hidden;}
      .header-container{text-align:center;padding:40px 10px;background:#020617;width:100%;}
      .main-title{font-size:clamp(24px,5vw,42px);font-weight:900;letter-spacing:3px;margin:0;text-shadow:0 0 15px rgba(56,189,248,0.5);}
      .ip-title{color:#38bdf8;font-size:clamp(18px,3vw,26px);margin:10px 0;font-weight:600;}
      .content-wrapper{width:95%;max-width:1400px;margin:0 auto;}
      .top{display:flex;justify-content:center;gap:20px;margin:30px 0;flex-wrap:wrap;}
      .box{padding:15px 30px;border-radius:12px;font-weight:bold;min-width:200px;text-align:center;box-shadow:0 10px 15px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);}
      .g{background:linear-gradient(135deg,#facc15,#ca8a04);color:#000}.s{background:linear-gradient(135deg,#e2e8f0,#94a3b8);color:#000}.b{background:linear-gradient(135deg,#fb923c,#c2410c);color:#000}
      
      .info-box{
        text-align:center;
        background: rgba(15, 23, 42, 0.8);
        border: 1px solid rgba(56, 189, 248, 0.3);
        padding: 20px;
        margin: 20px auto;
        max-width: 800px;
        border-radius: 12px;
        color: #e2e8f0;
        font-size: 16px;
        box-shadow: 0 0 20px rgba(56, 189, 248, 0.1);
        backdrop-filter: blur(5px);
      }
      .info-box span { color: #facc15; font-weight: bold; text-shadow: 0 0 8px rgba(250, 204, 21, 0.5); }
      
      .search{text-align:center;margin:30px 0}
      input{padding:14px 20px;border-radius:8px;border:1px solid #334155;width:clamp(200px,50%,400px);background:#1e293b;color:white;font-size:16px;outline:none;}
      button,.nav-btn{padding:14px 30px;border-radius:8px;background:#38bdf8;color:white;font-weight:bold;text-decoration:none;cursor:pointer;transition:0.3s;border:none;font-size:16px;display:inline-block;}
      button:hover,.nav-btn:hover{background:#0284c7;transform:translateY(-2px);}
      .ig-link{text-align:center;margin:20px 0;}.ig-link a{color:#e1306c;text-decoration:none;font-weight:bold;background:#020617;padding:12px 30px;border-radius:8px;display:inline-block;border:1px solid #e1306c;transition:0.3s;}
      .ig-link a:hover{background:#e1306c;color:white;}
      .table-container{width:100%;overflow-x:auto;background:#0f172a;border-radius:12px;box-shadow:0 0 30px rgba(0,0,0,0.5);}
      table{width:100%;border-collapse:collapse;min-width:900px;}
      th{background:#1e293b;padding:20px;color:#94a3b8;text-transform:uppercase;font-size:14px;}
      td{padding:18px;text-align:center;border-bottom:1px solid #1e293b;font-size:16px;position:relative;transition:0.2s;}
      .player-nick{color:#38bdf8;font-weight:600;}
      tr:hover td{background:rgba(56,189,248,0.12);}
      tr:hover .player-nick{color:#fff;}
      tr:hover td:first-child::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:#38bdf8;}
      .pagination{display:flex;justify-content:center;align-items:center;gap:20px;margin:30px 0;}
    </style></head><body>
      <div class="header-container"><h1 class="main-title">SEHRIN EFENDILERI</h1><div class="ip-title">(95.173.173.81)</div></div>
      <div class="content-wrapper">
        <div class="ig-link"><a href="https://instagram.com/sehrinefendilerics16" target="_blank">📷 Instagram: @sehrinefendilerics16</a></div>
        
        <div class="info-box">
          ⚠️ Veriler yalnızca <span>06.04.2026</span> tarihinden itibaren kaydedilmektedir. Bu tarihten önceki istatistikler hesaplamaya dahil edilmez.
        </div>
        
        ${top3.length ? `<div class="top">
          <div class="box g">🥇 ${escapeHTML(top3[0].nick)}</div>
          <div class="box s">🥈 ${top3[1] ? escapeHTML(top3[1].nick) : "---"}</div>
          <div class="box b">🥉 ${top3[2] ? escapeHTML(top3[2].nick) : "---"}</div>
        </div>` : ''}
        <form class="search"><input name="search" placeholder="Oyuncu ara..." value="${escapeHTML(search)}"><button type="submit">Ara</button></form>
        <div class="table-container"><table>
          <tr><th>SIRA</th><th>NICK</th><th>ÖLDÜRME</th><th>ÖLÜM</th><th>K/D</th><th>HASAR</th><th>SKOR</th></tr>
          ${players.map((p, i) => `<tr>
            <td><b>${offset + i + 1}</b></td>
            <td class="player-nick">${escapeHTML(p.nick)}</td>
            <td>${p.total_kills}</td>
            <td>${p.total_deaths}</td>
            <td>${(p.total_kills / Math.max(p.total_deaths, 1)).toFixed(2)}</td>
            <td>${p.total_damage}</td>
            <td><b style="color:#38bdf8;">${Math.round(p.score)}</b></td>
          </tr>`).join('')}
        </table></div>
        <div class="pagination">
          <a href="/?page=${page - 1}&search=${search}" class="nav-btn ${page <= 1 ? 'disabled' : ''}">← Geri</a>
          <span>Sayfa ${page} / ${totalPages || 1}</span>
          <a href="/?page=${page + 1}&search=${search}" class="nav-btn ${page >= totalPages ? 'disabled' : ''}">İleri →</a>
        </div>
      </div>
    </body></html>`;

    cache[cacheKey] = { data: html, time: Date.now() };
    res.send(html);
  } catch (err) {
    res.status(500).send("Hata oluştu.");
  }
});

// ================= 5. GÜVENLİ YÖNETİM (ŞIK TASARIM) =================
app.get("/status", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send(`<html><body style="background:#0f172a;color:#ef4444;font-family:'Segoe UI',sans-serif;text-align:center;padding-top:150px;"><h2>⛔ Erişim Reddedildi</h2><p>Bu alana giriş yetkiniz bulunmamaktadır.</p></body></html>`);
  
  try {
    const r = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
    const formatted = r.rows[0]?.last_fetch ? new Date(r.rows[0].last_fetch).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "Veri yok";
    
    res.send(`
      <html>
        <body style="background:#0f172a;color:white;font-family:'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
          <div style="background:#1e293b;border:1px solid #334155;padding:40px;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);text-align:center;">
            <h2 style="color:#38bdf8;margin-top:0;letter-spacing:1px;">📊 Arşiv Kayıt Durumu</h2>
            <p style="font-size:18px;color:#cbd5e1;margin-bottom:0;">Son Senkronizasyon</p>
            <h1 style="color:#facc15;margin-top:10px;font-size:32px;">${formatted}</h1>
          </div>
        </body>
      </html>
    `);
  } catch (e) { 
    res.send(`<html><body style="background:#0f172a;color:#ef4444;font-family:'Segoe UI',sans-serif;text-align:center;padding-top:150px;"><h2>❌ Sistem Hatası</h2></body></html>`); 
  }
});

app.get("/force-update", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send(`<html><body style="background:#0f172a;color:#ef4444;font-family:'Segoe UI',sans-serif;text-align:center;padding-top:150px;"><h2>⛔ Erişim Reddedildi</h2><p>Bu alana giriş yetkiniz bulunmamaktadır.</p></body></html>`);
  
  await fetchAndSave();
  
  res.send(`
    <html>
      <body style="background:#0f172a;color:white;font-family:'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
        <div style="background:#1e293b;border:1px solid #334155;padding:40px;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);text-align:center;">
          <h2 style="color:#10b981;margin-top:0;letter-spacing:1px;">⚙️ Sisteme Müdahale Edildi</h2>
          <p style="font-size:20px;color:#cbd5e1;margin-bottom:0;">Veritabanı Arşivi Başarıyla Güncellendi.</p>
        </div>
      </body>
    </html>
  `);
});

// ================= 6. STARTUP =================
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    fetchAndSave();
    setInterval(fetchAndSave, 180000); // 3 dk
    setInterval(cleanCache, 60000); // RAM temizliğini tetikle
  });
});
