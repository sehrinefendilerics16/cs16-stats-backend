const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await client.connect();

    await client.query(`
      DROP TABLE IF EXISTS players;

      CREATE TABLE players (
        nick TEXT PRIMARY KEY,
        total_kills INTEGER DEFAULT 0,
        total_deaths INTEGER DEFAULT 0,
        total_damage INTEGER DEFAULT 0,
        last_kills INTEGER DEFAULT 0,
        last_deaths INTEGER DEFAULT 0,
        last_damage INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("DB HAZIR");

    await client.end();
    process.exit(0);

  } catch (err) {
    console.error("DB HATA:", err);
    process.exit(1);
  }
}

run();
