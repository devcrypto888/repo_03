import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { settingsTable } from './db/schema';

/** Tiny key/value store for operational flags and job bookkeeping. */
export const settings = {
  async get(key: string): Promise<string | null> {
    const [row] = await db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, key));
    return row?.value ?? null;
  },

  async set(key: string, value: string) {
    await db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: sql`now()` } });
  },

  /**
   * Compare-and-set: updates only if the current value is `expected`.
   * Returns false if someone else changed it first.
   */
  async cas(key: string, expected: string | null, next: string): Promise<boolean> {
    const res =
      expected === null
        ? await db.execute(sql`INSERT INTO system_settings (key, value) VALUES (${key}, ${next}) ON CONFLICT DO NOTHING`)
        : await db.execute(sql`UPDATE system_settings SET value = ${next}, updated_at = now() WHERE key = ${key} AND value = ${expected}`);
    return (res.rowCount ?? 0) > 0;
  },
};
