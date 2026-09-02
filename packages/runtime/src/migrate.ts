import pg from "pg";

import { requiredRetailPriceEnvironmentValue } from "./environment.js";
import { runConversationMigrations } from "./schema-migrator.js";

const databaseUrl = requiredRetailPriceEnvironmentValue(process.env, "DATABASE_URL");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
try {
  const result = await runConversationMigrations(pool);
  for (const filename of result.applied) process.stdout.write(`applied ${filename}\n`);
  process.stdout.write(`verified ${result.verifiedTables} conversation tables\n`);
} finally {
  await pool.end();
}
