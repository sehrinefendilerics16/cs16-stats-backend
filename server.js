const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const app = express();
app.set('trust proxy', 1);

// ✅ KRİTİK EKLEME: Sockets verilerini okuyabilmek için body-parser ayarları
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: '*/*', limit: '1mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= 1. OTOMATİK MAİL SİSTEMİ =================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "leventistemi@gmail.com",
    pass: process.env.EMAIL_PASS
  }
});

let lastMailTime = 0;
const sendAlertMail = async (errorMsg) => {
  const now = Date.now();
  if (now - lastMailTime < 3600000) return;

  const mailOptions = {
    from: '"Şehrin Efendileri Sistem" <leventistemi@gmail.com>',
    to: "leventistemi@gmail.com",
    subject: "⚠️ SİSTEM ARIZA BİLDİRİMİ - SEHRIN EFENDILERI",
    text: `Hata Detayı: ${errorMsg}\nZaman: ${new Date().toLocaleString("tr-TR")}`
  };
  try { 
    await transporter.sendMail(mailOptions); 
    lastMailTime = now;
  } catch (e) { console.error("Mail hatası:", e.message); }
};

const BASE_URL = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";
let cache = {};
const CACHE_LIMIT = 50;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(20).toString('hex'); 
const logoUrl = "https://raw.githubusercontent.com/sehrinefendilerics16/cs16-stats-backend/main/background.jpeg?v=3";

// ================= 2. GÜVENLİK: RATE LIMITER =================
let rateMap = new Map();
function rateLimit(req, limit = 60, windowMs = 60000) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const now = Date.now();
  if (!rateMap.has(ip)) { rateMap.set(ip, { count: 1, start: now }); return true; }
  const data = rateMap.get(ip);
  if (now - data.start > windowMs) { rateMap.set(ip, { count: 1, start: now }); return true; }
  if (data.count >= limit) return false;
  data.count++; return true;
}

function cleanCache() {
  const now = Date.now();
  for (const key in cache) { if (now - cache[key].time > 30000) delete cache[key]; }
  if (Object.keys(cache).length > CACHE_LIMIT) cache = {}; 
  for (const [ip, data] of rateMap.entries()) {
    if (now - data.start > 60000) rateMap.delete(ip);
  }
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next(); // API yollarını global limitten ayırıyoruz
  if (!rateLimit(req)) return res.status(429).send("Çok fazla istek yolladınız.");
  next();
});

// ================= 3. VERİTABANI BAŞLATMA =================
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
      CREATE TABLE IF NOT EXISTS chat_logs (
        id SERIAL PRIMARY KEY, oyuncu_adi TEXT, steam_id TEXT, ip_adresi TEXT, durum_takim TEXT, 
        yetki TEXT, mesaj TEXT, mesaj_hash TEXT UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("⚔️ Arşiv Sistemi Aktif.");
  } finally { client.release(); }
}

// ================= 4. RANK ARŞİV MOTORU (FETCH) =================
let isRunning = false;
async function fetchPlayers(retry = 2) {
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 8000 });
    const $ = cheerio.load(data);
    let players = [];
    const rows = $("table.CSS_Table_Example tr").length ? $("table.CSS_Table_Example tr") : $("table tr");

    const firstRowCols = $(rows[0]).find("td, th");
    if (!$(firstRowCols[2]).text().toLowerCase().includes("öldürme")) throw new Error("Sütun hatası!");

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
    if (!players || players.length < 5) throw new Error("Veri yetersiz");
    const newHash = crypto.createHash("md5").update(JSON.stringify(players.sort())).digest("hex");
    const lastHashRes = await client.query(`SELECT last_hash FROM system_log ORDER BY id DESC LIMIT 1`);
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
  } catch (err) { if (client) await client.query('ROLLBACK'); console.error("Motor Hatası:", err.message); }
  finally { client.release(); isRunning = false; }
}

// ================= 5. WEB ARAYÜZÜ (GÖRSEL TABLO) =================
app.get("/", async (req, res) => {
  const search = (req.query.search || "").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;

  try {
    const totalRes = await pool.query(`SELECT COUNT(*) FROM players WHERE LOWER(nick) LIKE $1`, [`%${search}%`]);
    const totalPages = Math.ceil(parseInt(totalRes.rows[0].count) / limit) || 1;
    const query = `
      WITH all_ranked AS (
        SELECT *, (total_kills - total_deaths) as net_kills, (total_kills::float / GREATEST(total_deaths, 1)) as kd,
        RANK() OVER (ORDER BY ( ( (total_kills - total_deaths) * 1.0) + ( (total_kills::float / GREATEST(total_deaths, 1)) * 5.0) + (hs_percent * 1.5) + (total_damage / 1000.0) ) DESC) as real_rank
        FROM players
      )
      SELECT * FROM all_ranked WHERE LOWER(nick) LIKE $1 ORDER BY real_rank ASC LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [`%${search}%`, limit, offset]);
    const lastUpdate = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
    
    // Basitleştirilmiş HTML cevabı (Senin orijinal CSS/Tasarımın buraya dahil)
    let html = `<html><head><meta charset="UTF-8"><title>SEHRIN EFENDILERI</title>
    <style>body{background:#0f172a; color:white; font-family:sans-serif;} table{width:100%; border-collapse:collapse;} th,td{border:1px solid #1e293b; padding:10px; text-align:center;} th{background:#020617; color:#38bdf8;}</style>
    </head><body><h1 style="text-align:center;">ŞEHRİN EFENDİLERİ RANK</h1>
    <div style="text-align:center; margin-bottom:20px;">Son Güncelleme: ${lastUpdate.rows[0]?.last_fetch?.toLocaleString("tr-TR") || "---"}</div>
    <form style="text-align:center;"><input name="search" value="${search}"><button>Ara</button></form>
    <table><thead><tr><th>#</th><th>NICK</th><th>KILLS</th><th>DEATHS</th><th>K/D</th><th>HASAR</th></tr></thead><tbody>
    ${result.rows.map(p => `<tr><td>${p.real_rank}</td><td style="color:#38bdf8;">${p.nick}</td><td>${p.total_kills}</td><td>${p.total_deaths}</td><td>${p.kd.toFixed(2)}</td><td>${p.total_damage}</td></tr>`).join('')}
    </tbody></table></body></html>`;
    res.send(html);
  } catch (err) { res.status(500).send("Hata oluştu."); }
});

// ================= 6. ADMIN & FORCE UPDATE =================
app.get("/status", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send("Reddedildi");
  const r = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
  res.send(`Sistem Aktif. Son çekim: ${r.rows[0]?.last_fetch}`);
});

app.get("/force-update", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send("Reddedildi");
  await fetchAndSave();
  res.send("Güncelleme yapıldı.");
});

// ================= 7. SOCKET FIX (CS 1.6 İÇİN ÖZEL KAPISI) =================
const proxyRateMap = new Map();
app.post('/api/chat-logs-http', async (req, res) => {
    // Rate Limit
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const now = Date.now();
    if (!proxyRateMap.has(ip)) proxyRateMap.set(ip, { count: 1, start: now });
    else {
        const d = proxyRateMap.get(ip);
        if (now - d.start < 60000 && d.count >= 200) return res.status(429).json({error: "Limit"});
        if (now - d.start > 60000) { d.count = 1; d.start = now; } else d.count++;
    }

    const key = req.headers['x-api-key'] || req.headers['X-API-Key'];
    if (key !== process.env.LOG_API_KEY) return res.status(403).json({ error: "Yetkisiz" });

    let loglar = req.body;
    if (typeof loglar === "string") {
        try { loglar = JSON.parse(loglar); } catch (e) { return res.status(400).json({ error: "JSON bozuk" }); }
    }

    if (!Array.isArray(loglar) || loglar.length === 0) return res.status(400).json({ error: "Veri yok" });

    try {
        const values = [];
        const placeholders = [];
        let index = 1;

        for (const log of loglar) {
            const s_id = log.steam_id || `SYS_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            const hash = crypto.createHash('sha256').update(`${s_id}|${log.mesaj}`).digest('hex');

            values.push(log.oyuncu_adi, s_id, log.ip_adresi, log.durum_takim, log.yetki, log.mesaj, hash);
            placeholders.push(`($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++})`);
        }

        await pool.query(`INSERT INTO chat_logs (oyuncu_adi, steam_id, ip_adresi, durum_takim, yetki, mesaj, mesaj_hash) VALUES ${placeholders.join(",")} ON CONFLICT DO NOTHING`, values);
        res.json({ success: true });
    } catch (e) { sendAlertMail(e.message); res.status(500).json({ error: "fail" }); }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    fetchAndSave();
    setInterval(fetchAndSave, 180000); 
    setInterval(cleanCache, 60000);
  });
});
