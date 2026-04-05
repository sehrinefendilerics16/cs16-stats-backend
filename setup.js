const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function run() {
  try {
    await client.connect();
    console.log("DB bağlandı");

    await client.query(`
      DROP TABLE IF EXISTS players;

      CREATE TABLE players (
        nick TEXT PRIMARY KEY,
        total_kills INTEGER NOT NULL DEFAULT 0,
        total_damage INTEGER NOT NULL DEFAULT 0,
        last_kills INTEGER NOT NULL DEFAULT 0,
        last_damage INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("Tablo oluşturuldu");

    const res = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'players';
    `);

    console.log("Kolonlar:");
    console.table(res.rows);

  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

run();
