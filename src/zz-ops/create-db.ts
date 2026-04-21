import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";
import { Client } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
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

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.trim()) {
    throw new Error("DATABASE_URL is required in selected env file");
  }
  const useIam = toBool(process.env.DATABASE_USE_IAM);
  const ssl = process.env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined;
  const sqlPath = path.resolve("assets/db.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = useIam
    ? await createIamClient(databaseUrl, ssl)
    : new Client({
        connectionString: databaseUrl,
        ssl
      });
  await client.connect();
  await client.query(sql);
  await client.end();

  logger.info("ops_create_db_ok", { environment: normalized, databaseUrl: "***", sqlPath });
}

async function createIamClient(
  databaseUrl: string,
  ssl: { rejectUnauthorized: boolean } | undefined
): Promise<Client> {
  const parsed = new URL(databaseUrl);
  const host = (process.env.DATABASE_IAM_HOST || "").trim() || parsed.hostname;
  const port = Number(process.env.DATABASE_IAM_PORT || parsed.port || 5432);
  const user = (process.env.DATABASE_IAM_USER || "").trim() || decodeURIComponent(parsed.username || "postgres");
  const database =
    (process.env.DATABASE_IAM_DBNAME || "").trim() || parsed.pathname.replace(/^\//, "") || "postgres";
  const region =
    (process.env.DATABASE_IAM_REGION || "").trim() ||
    inferRegionFromHost(host) ||
    (() => {
      throw new Error("DATABASE_IAM_REGION is required when DATABASE_USE_IAM=true");
    })();

  const signer = new Signer({
    region,
    hostname: host,
    port,
    username: user
  });
  const password = await signer.getAuthToken();

  return new Client({
    host,
    port,
    database,
    user,
    password,
    ssl
  });
}

function inferRegionFromHost(host: string): string | null {
  const match = host.match(/\.([a-z]{2}-[a-z]+-\d)\.rds\.amazonaws\.com$/);
  return match?.[1] ?? null;
}

function toBool(value: string | undefined): boolean {
  if (!value || !value.trim()) return false;
  const s = value.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
