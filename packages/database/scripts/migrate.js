const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config();

const migrationsDir = path.resolve(process.cwd(), "db", "migrations");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is missing in .env");
  }

  const client = new Client({
    connectionString: databaseUrl,
  });

  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const alreadyExecuted = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file]
      );

      if (alreadyExecuted.rowCount > 0) {
        console.log(`SKIP ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8").replace(/^\uFEFF/, "");

      console.log(`RUN  ${file}`);

      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");

      console.log(`DONE ${file}`);
    }

    console.log("All migrations completed.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Migration failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();

