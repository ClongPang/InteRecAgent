import pg from "pg";

import { runConversationMigrations } from "./schema-migrator.js";

const databaseUrl = process.env["INTEREC_DATABASE_URL"];
if (!databaseUrl) throw new Error("INTEREC_DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
try {
  const result = await runConversationMigrations(pool);
  for (const filename of result.applied) process.stdout.write(`applied ${filename}\n`);
  process.stdout.write(`verified ${result.verifiedTables} conversation tables\n`);
} finally {
  await pool.end();
}
