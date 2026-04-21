import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { Logger } from "../utils/logger.js";

async function main(): Promise<void> {
  const logger = new Logger();
  const rl = createInterface({ input, output });
  const answer = await rl.question("Apply DB schema to which env? (development/live/test) [development]: ");
  rl.close();
  const selected = (answer.trim() || "development").toLowerCase();
  const normalized = selected === "live" ? "production" : selected;
  if (!["development", "test", "production"].includes(normalized)) {
    throw new Error("invalid environment; expected development, live, or test");
  }

  const envPath = path.resolve(`.env.${normalized}`);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }

  const dbPath = process.env.DATABASE_PATH;
  if (!dbPath || !dbPath.trim()) {
    throw new Error("DATABASE_PATH is required in selected env file");
  }
  const sqlPath = path.resolve("assets/db.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const sqlite = new Database(path.resolve(dbPath));
  sqlite.exec(sql);
  sqlite.close();

  logger.info("ops_create_db_ok", { environment: normalized, databasePath: dbPath, sqlPath });
}

try {
  await main();
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
}
