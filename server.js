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

const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(20).toString('hex'); 
const logoUrl = "https://raw.githubusercontent.com/sehrinefendilerics16/cs16-stats-backend/main/background.jpeg?v=3";

// TÜRKİYE TARİH VE SAAT FONKSİYONU
const getTRDate = (date = new Date()) => {
  return date.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
};

function cleanCache() {
  const now = Date.now();
  for (const key in cache) {
    if (now - cache[key].time > 30000) delete cache[key];
  }
  if (Object.keys(cache).length > CACHE_LIMIT) cache = {}; 
}

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY, nick TEXT UNIQUE, total_kills INT DEFAULT 0, total_deaths INT DEFAULT 0,
        total_damage INT DEFAULT 0, last_kills INT DEFAULT 0, last_deaths INT DEFAULT 0, last_damage INT DEFAULT 0,
        hs_percent FLOAT DEFAULT 0, accuracy FLOAT DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_nick_lower ON players (LOWER(nick));
      CREATE TABLE IF NOT EXISTS system_log (
        id SERIAL PRIMARY KEY, last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_hash TEXT
      );
    `);
    console.log("⚔️ Arşiv Sistemi Aktif.");
  } finally { client.release(); }
}

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
        nick, kills: parseInt($(cols[2]).text()) || 0,
        hsPercent: parseFloat($(cols[3]).text().match(/\((.*?)%\)/)?.[1]) || 0,
        deaths: parseInt($(cols[4]).text()) || 0,
        accuracy: parseFloat($(cols[6]).text().match(/\((.*?)%\)/)?.[1]) || 0,
        damage: parseInt($(cols[7]).text()) || 0
      });
    });
    return players;
  } catch (err) { if (retry > 0) return fetchPlayers(retry - 1); throw err; }
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
    if (lastHashRes.rows[0]?.last_hash === newHash) return; 

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
  } catch (err) { if (client) await client.query('ROLLBACK'); console.error("Motor Hatası:", err.message); } 
  finally { client.release(); isRunning = false; }
}

// ================= 4. ARAYÜZ =================
app.get("/", async (req, res) => {
  const userAgent = req.headers['user-agent'] || "";
  const isMobile = /Mobile|Android|iPhone/i.test(userAgent);
  const search = (req.query.search || "").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;
  const cacheKey = `${search}_p${page}_${isMobile}`;

  if (cache[cacheKey] && Date.now() - cache[cacheKey].time < 30000) return res.send(cache[cacheKey].data);

  try {
    const totalRes = await pool.query(`SELECT COUNT(*) FROM players WHERE LOWER(nick) LIKE $1`, [`%${search}%`]);
    const totalPlayers = parseInt(totalRes.rows[0].count);
    const totalPages = Math.ceil(totalPlayers / limit) || 1;

    const query = `
      WITH all_ranked AS (
        SELECT *, (total_kills - total_deaths) as net_kills, (total_kills::float / GREATEST(total_deaths, 1)) as kd,
        RANK() OVER (ORDER BY ( ( (total_kills - total_deaths) * 1.0) + ( (total_kills::float / GREATEST(total_deaths, 1)) * 5.0) + (hs_percent * 1.5) + (total_damage / 1000.0) ) DESC) as real_rank
        FROM players
      )
      SELECT *, ( (net_kills * 1.0) + (kd * 5.0) + (hs_percent * 1.5) + (total_damage / 1000.0) ) as score
      FROM all_ranked WHERE LOWER(nick) LIKE $1 ORDER BY score DESC LIMIT $2 OFFSET $3
    `;
    const logRes = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
    const result = await pool.query(query, [`%${search}%`, limit, offset]);
    const players = result.rows;
    
    const rawDate = logRes.rows[0]?.last_fetch;
    const lastUpdateDate = rawDate ? new Date(rawDate).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/\//g, ".") : "---";
    
    const escapeHTML = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
    
    let html = `<html><head>
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-EGWK9NSWZ2"></script>
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());

        gtag('config', 'G-EGWK9NSWZ2');
      </script>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SEHRIN EFENDILERI</title>
      <link rel="icon" href="${logoUrl}">
      <style>
      body{ background: linear-gradient(rgba(15, 23, 42, 0.75), rgba(15, 23, 42, 0.75)), url('${logoUrl}') no-repeat center center fixed; background-size: cover; color:white; font-family:'Segoe UI',sans-serif; margin:0; padding-bottom:50px; overflow-x:hidden; }
      .header-container{text-align:center;padding:30px 10px;background:rgba(2, 6, 23, 0.85);}
      .main-title{font-size:clamp(22px,5vw,42px);font-weight:900;letter-spacing:2px;margin:0;text-shadow:0 0 15px rgba(56,189,248,0.5);}
      .ip-title{color:#38bdf8;font-size:clamp(16px,3vw,26px);margin:5px 0;}
      .content-wrapper{width:98%;max-width:1400px;margin:0 auto;}
      .ig-link{text-align:center;margin:15px 0;}.ig-link a{color:#e1306c;text-decoration:none;font-weight:bold;background:rgba(2, 6, 23, 0.9);padding:10px 20px;border-radius:6px;border:1px solid #e1306c;}
      .info-box{ text-align:center; background: rgba(15, 23, 42, 0.9); border: 1px solid rgba(56, 189, 248, 0.3); padding: 18px; margin: 20px auto; max-width: 1200px; border-radius: 10px; font-size: 16px; }
      .info-box span { color: #facc15; font-weight: bold; font-size: 18px; }
      .update-badge { text-align: center; margin: 0 auto 30px; font-size: 15px; color: #e2e8f0; background: rgba(30, 41, 59, 0.85); display: table; padding: 10px 25px; border-radius: 30px; border: 1px solid rgba(56, 189, 248, 0.3); }
      .search{text-align:center;margin:25px 0; display:flex; justify-content:center; gap:8px; flex-wrap: wrap;}
      input{padding:14px;border-radius:6px;border:1px solid #334155;width:50%;background:#1e293b;color:white;outline:none;font-size:16px;}
      button{padding:14px 30px;border-radius:6px;background:#38bdf8;color:white;font-weight:bold;border:none;cursor:pointer;font-size:16px;}
      .reset-btn { padding: 14px 20px; border-radius: 6px; background: rgba(30, 41, 59, 0.9); border: 1px solid #38bdf8; color: #38bdf8; font-weight: bold; text-decoration: none; font-size: 15px; display:flex; align-items:center; justify-content:center;}
      .table-container{ width:100%; overflow-x:auto; background:rgba(15, 23, 42, 0.95); border-radius:8px; border: 1px solid #1e293b; }
      table{width:100%; border-collapse:collapse; table-layout: fixed; min-width: 800px;}
      th, td { border: 1px solid #1e293b; padding: 12px 10px; text-align: center; font-size: 15px; }
      th { background:#020617; color:#38bdf8; text-transform:uppercase; font-size:13px; letter-spacing: 1px; }
      tr:hover td { background: rgba(56, 189, 248, 0.2) !important; }
      tr:nth-child(even) td { background: rgba(30, 41, 59, 0.4); }
      
      /* STICKY COLUMN FIX */
      .player-nick{ color:#38bdf8; font-weight:600; text-align: left; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
      
      .rank-badge { display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; min-width: 50px; border-radius: 8px; font-weight: 800; font-size: 14px; gap: 4px; }
      .rank-1 { background: linear-gradient(135deg, #facc15, #eab308); color: #422006; border: 1px solid #fef08a; }
      .rank-2 { background: linear-gradient(135deg, #e2e8f0, #94a3b8); color: #0f172a; border: 1px solid #f8fafc; }
      .rank-3 { background: linear-gradient(135deg, #fdba74, #ea580c); color: #431407; border: 1px solid #fed7aa; }
      
      .pagination { display: flex; justify-content: center; gap: 15px; margin: 30px 0; align-items: center; }
      .pagination a { background: rgba(30, 41, 59, 0.9); border: 1px solid #38bdf8; color: #38bdf8; padding: 12px 25px; border-radius: 6px; font-weight: bold; text-decoration: none; }
      .pagination span { background: #020617; border: 1px solid #1e293b; color: white; padding: 12px 25px; border-radius: 6px; font-weight: bold; }

      @media (max-width: 768px) {
        th:nth-child(2), td:nth-child(2) { 
          position: sticky !important; 
          left: 0 !important; 
          z-index: 99 !important; 
          background: #0f172a !important; 
          width: 130px !important;
          box-shadow: 2px 0 5px rgba(0,0,0,0.5);
        }
        th:nth-child(2) { z-index: 100 !important; }
        /* KATI ARKA PLAN - SAYDAMLAŞMAYI VE İÇ İÇE GEÇMEYİ ENGELLER */
        tr:hover td:nth-child(2) { background: #1a243a !important; }
        
        .pagination { flex-direction: column; width: 90%; margin: 20px auto; gap: 10px; }
      }
      </style></head><body>
      <div class="header-container"><h1 class="main-title">SEHRIN EFENDILERI</h1><div class="ip-title">(95.173.173.81)</div></div>
      <div class="content-wrapper">
        <div class="ig-link"><a href="https://instagram.com/sehrinefendilerics16" target="_blank">📷 Instagram: @sehrinefendilerics16</a></div>
        <div class="info-box">⚠️ Veriler <span>06.04.2026</span> tarihinden itibaren kaydedilmektedir.</div>
        <div class="update-badge">Sıralama verileri en son <b>${lastUpdateDate}</b> tarihinde güncellendi.</div>
        <form class="search" method="GET">
          <input name="search" placeholder="Nick giriniz..." value="${escapeHTML(search)}">
          <button type="submit">Ara</button>
          ${search ? `<a href="/" class="reset-btn">↩ Tüm Listeye Dön</a>` : ''}
        </form>
        <div class="table-container"><table><thead><tr><th>#</th><th>NICK</th><th>ÖLDÜRME</th><th>ÖLÜM</th><th>K/D</th><th>HASAR</th><th>SKOR</th></tr></thead><tbody>
        ${players.map((p) => {
          const kd = (p.total_kills / Math.max(p.total_deaths, 1));
          const r = parseInt(p.real_rank);
          let rankDisplay = `<b>${r}</b>`;
          if (r === 1) rankDisplay = `<span class="rank-badge rank-1">🥇 1</span>`;
          else if (r === 2) rankDisplay = `<span class="rank-badge rank-2">🥈 2</span>`;
          else if (r === 3) rankDisplay = `<span class="rank-badge rank-3">🥉 3</span>`;
          return `<tr><td>${rankDisplay}</td><td><span class="player-nick">${escapeHTML(p.nick)}</span></td><td>${p.total_kills}</td><td>${p.total_deaths}</td><td>${kd.toFixed(2)}</td><td>${p.total_damage}</td><td><b style="color:#38bdf8;">${Math.round(p.score)}</b></td></tr>`;
        }).join('')}
        </tbody></table></div>
        <div class="pagination">
          ${page > 1 ? `<a href="/?page=${page - 1}${search ? '&search='+search : ''}">« Önceki Sayfa</a>` : ''}
          <span>Sayfa ${page} / ${totalPages}</span>
          ${page < totalPages ? `<a href="/?page=${page + 1}${search ? '&search='+search : ''}">Sonraki Sayfa »</a>` : ''}
        </div>
      </div></body></html>`;
    cache[cacheKey] = { data: html, time: Date.now() }; res.send(html);
  } catch (err) { res.status(500).send("Hata."); }
});

// ================= 5. YÖNETİM LİNKLERİ (HAVALI SİYAH TASARIM) =================
const adminLayout = (title, message, subMessage) => `
  <html><head><meta charset="UTF-8"><title>${title}</title>
  <link rel="icon" href="${logoUrl}">
  <style>
    body{ background: #020617; color:white; font-family:'Segoe UI',sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    .card{ background: rgba(15, 23, 42, 0.95); border: 1px solid #38bdf8; padding: 40px; border-radius: 12px; text-align: center; box-shadow: 0 0 30px rgba(56, 189, 248, 0.2); max-width: 500px; }
    h1{ color: #38bdf8; margin-bottom: 20px; font-size: 24px; letter-spacing: 1px; }
    p{ font-size: 18px; margin: 10px 0; color: #e2e8f0; }
    .sub{ font-size: 14px; color: #94a3b8; margin-top: 20px; border-top: 1px solid #1e293b; padding-top: 20px; }
    .sub b { color: #38bdf8; }
  </style></head><body>
    <div class="card"><h1>${title}</h1><p>${message}</p><div class="sub">${subMessage}</div></div>
  </body></html>`;

app.get("/status", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send("Erişim Reddedildi");
  try {
    const r = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
    const trDate = r.rows[0]?.last_fetch ? new Date(r.rows[0].last_fetch).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/\//g, ".") : "Veri yok";
    res.send(adminLayout("📊 SİSTEM DURUMU", "🛡️ Sistem Aktif ve Kayıtta.", `Son Veri Çekimi: <b>${trDate}</b>`));
  } catch (e) { res.status(500).send("Hata"); }
});

app.get("/force-update", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send("Erişim Reddedildi");
  await fetchAndSave();
  res.send(adminLayout("⚙️ İŞLEM BAŞARILI", "✅ Manuel Güncelleme Tetiklendi.", "Veritabanı OyunYöneticisi ile senkronize edildi."));
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    fetchAndSave();
    setInterval(fetchAndSave, 180000); 
    setInterval(cleanCache, 60000);
  });
});
