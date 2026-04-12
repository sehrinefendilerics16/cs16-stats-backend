const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const app = express();
app.set('trust proxy', 1);

// ✅ KRİTİK: Sockets üzerinden gelen chat verilerini okuyabilmek için şart
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
    subject: "⚠️ SİSTEM ARIZA BİLDİRİMİ",
    text: `Hata: ${errorMsg}\nZaman: ${new Date().toLocaleString("tr-TR")}`
  };
  try { await transporter.sendMail(mailOptions); lastMailTime = now; } catch (e) {}
};

const BASE_URL = "https://panel25.oyunyoneticisi.com/rank/rank_all.php?ip=95.173.173.81";
let cache = {};
const ADMIN_KEY = process.env.ADMIN_KEY || "se_admin_123";
const logoUrl = "https://raw.githubusercontent.com/sehrinefendilerics16/cs16-stats-backend/main/background.jpeg?v=3";

// ================= 2. GÜVENLİK: RATE LIMITER =================
let rateMap = new Map();
function rateLimit(req, limit = 60) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const now = Date.now();
  if (!rateMap.has(ip)) { rateMap.set(ip, { count: 1, start: now }); return true; }
  const data = rateMap.get(ip);
  if (now - data.start > 60000) { rateMap.set(ip, { count: 1, start: now }); return true; }
  if (data.count >= limit) return false;
  data.count++; return true;
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!rateLimit(req)) return res.status(429).send("Hız sınırını aştınız.");
  next();
});

// ================= 3. VERİTABANI VE ARŞİV MOTORU =================
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
      CREATE TABLE IF NOT EXISTS system_log (id SERIAL PRIMARY KEY, last_fetch TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_hash TEXT);
      CREATE TABLE IF NOT EXISTS chat_logs (
        id SERIAL PRIMARY KEY, oyuncu_adi TEXT, steam_id TEXT, ip_adresi TEXT, durum_takim TEXT, 
        yetki TEXT, mesaj TEXT, mesaj_hash TEXT UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("⚔️ Arşiv Sistemi Aktif.");
  } finally { client.release(); }
}

let isRunning = false;
async function fetchAndSave() {
  if (isRunning) return;
  isRunning = true;
  const client = await pool.connect();
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 8000 });
    const $ = cheerio.load(data);
    let players = [];
    const rows = $("table.CSS_Table_Example tr").length ? $("table.CSS_Table_Example tr") : $("table tr");

    rows.each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find("td");
      if (cols.length < 8) return;
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

    if (players.length < 5) throw new Error("Veri çekilemedi.");
    const newHash = crypto.createHash("md5").update(JSON.stringify(players.sort())).digest("hex");
    const lastHashRes = await client.query(`SELECT last_hash FROM system_log ORDER BY id DESC LIMIT 1`);
    
    if (lastHashRes.rows[0]?.last_hash !== newHash) {
      await client.query('BEGIN');
      for (const p of players) {
        await client.query(`
          INSERT INTO players (nick, total_kills, total_deaths, total_damage, last_kills, last_deaths, last_damage, hs_percent, accuracy)
          VALUES ($1, $2, $3, $4, $2, $3, $4, $5, $6)
          ON CONFLICT (nick) DO UPDATE SET
            total_kills = players.total_kills + (CASE WHEN $2 < players.last_kills THEN $2 ELSE $2 - players.last_kills END),
            total_deaths = players.total_deaths + (CASE WHEN $3 < players.last_deaths THEN $3 ELSE $3 - players.last_deaths END),
            total_damage = players.total_damage + (CASE WHEN $4 < players.last_damage THEN $4 ELSE $4 - players.last_damage END),
            last_kills = $2, last_deaths = $3, last_damage = $4, updated_at = CURRENT_TIMESTAMP;
        `, [p.nick, p.kills, p.deaths, p.damage, p.hsPercent, p.accuracy]);
      }
      await client.query(`INSERT INTO system_log (last_fetch, last_hash) VALUES (CURRENT_TIMESTAMP, $1)`, [newHash]);
      await client.query('COMMIT');
      cache = {};
    }
  } catch (err) { if (client) await client.query('ROLLBACK'); }
  finally { client.release(); isRunning = false; }
}

// ================= 4. GÖRSEL ARAYÜZ (TAM TASARIM) =================
app.get("/", async (req, res) => {
  const search = (req.query.search || "").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;

  try {
    const result = await pool.query(`
      WITH all_ranked AS (
        SELECT *, (total_kills - total_deaths) as net_kills, (total_kills::float / GREATEST(total_deaths, 1)) as kd,
        RANK() OVER (ORDER BY ( ( (total_kills - total_deaths) * 1.0) + ( (total_kills::float / GREATEST(total_deaths, 1)) * 5.0) + (hs_percent * 1.5) + (total_damage / 1000.0) ) DESC) as real_rank
        FROM players
      )
      SELECT * FROM all_ranked WHERE LOWER(nick) LIKE $1 ORDER BY real_rank ASC LIMIT $2 OFFSET $3
    `, [`%${search}%`, limit, offset]);

    const logRes = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
    const lastUpdateDate = logRes.rows[0]?.last_fetch ? new Date(logRes.rows[0].last_fetch).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "---";

    let html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SEHRIN EFENDILERI</title>
      <style>
        body{ background: linear-gradient(rgba(15, 23, 42, 0.8), rgba(15, 23, 42, 0.8)), url('${logoUrl}') no-repeat center center fixed; background-size: cover; color:white; font-family:sans-serif; margin:0; text-align:center; }
        .header{ background:rgba(2, 6, 23, 0.9); padding:20px; }
        table{ width:95%; max-width:1200px; margin:20px auto; border-collapse:collapse; background:rgba(15, 23, 42, 0.9); }
        th, td{ border:1px solid #1e293b; padding:12px; }
        th{ background:#020617; color:#38bdf8; text-transform:uppercase; }
        tr:nth-child(even){ background:rgba(30, 41, 59, 0.5); }
        .nick{ color:#38bdf8; font-weight:bold; }
      </style></head><body>
      <div class="header"><h1>ŞEHRİN EFENDİLERİ RANK</h1><p>Son Güncelleme: ${lastUpdateDate}</p></div>
      <form style="margin:20px;"><input name="search" placeholder="Nick..." value="${search}"><button>Ara</button></form>
      <div style="overflow-x:auto;"><table><thead><tr><th>#</th><th>NICK</th><th>KILLS</th><th>DEATHS</th><th>K/D</th><th>HASAR</th></tr></thead><tbody>
      ${result.rows.map(p => `<tr><td>${p.real_rank}</td><td class="nick">${p.nick}</td><td>${p.total_kills}</td><td>${p.total_deaths}</td><td>${p.kd.toFixed(2)}</td><td>${p.total_damage}</td></tr>`).join('')}
      </tbody></table></div></body></html>`;
    res.send(html);
  } catch (err) { res.status(500).send("Hata."); }
});

// ================= 5. YÖNETİM VE LOG API =================
app.get("/status", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send("Erişim Yok");
  const r = await pool.query(`SELECT last_fetch FROM system_log ORDER BY id DESC LIMIT 1`);
  res.send(`Aktif. Son çekim: ${r.rows[0]?.last_fetch}`);
});

app.post('/api/chat-logs-http', async (req, res) => {
    const key = req.headers['x-api-key'] || req.headers['X-API-Key'];
    if (key !== process.env.LOG_API_KEY) return res.status(403).json({ error: "Yetkisiz" });

    let loglar = req.body;
    if (typeof loglar === "string") { try { loglar = JSON.parse(loglar); } catch (e) { return res.status(400).send("JSON Hatalı"); } }
    if (!Array.isArray(loglar)) return res.status(400).send("Dizi bekleniyor");

    try {
        const values = [];
        const placeholders = [];
        let index = 1;
        for (const log of loglar) {
            const s_id = log.steam_id || `SYS_${Date.now()}_${Math.random()}`;
            const hash = crypto.createHash('sha256').update(`${s_id}|${log.mesaj}`).digest('hex');
            values.push(log.oyuncu_adi, s_id, log.ip_adresi, log.durum_takim, log.yetki, log.mesaj, hash);
            placeholders.push(`($${index++},$${index++},$${index++},$${index++},$${index++},$${index++},$${index++})`);
        }
        await pool.query(`INSERT INTO chat_logs (oyuncu_adi,steam_id,ip_adresi,durum_takim,yetki,mesaj,mesaj_hash) VALUES ${placeholders.join(",")} ON CONFLICT DO NOTHING`, values);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    fetchAndSave();
    setInterval(fetchAndSave, 180000);
    setInterval(cleanCache, 60000);
  });
});
