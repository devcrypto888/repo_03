import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/**
 * Nightly logical backup: pg_dump → gzip → multipart upload to object storage,
 * fully streamed. Nothing touches local disk, so it works on platforms with a
 * small ephemeral filesystem.
 *
 * Retention is GFS-style: keep 14 dailies, 8 weeklies (Sundays), 12 monthlies
 * (1st of month).
 */
const s3 = new S3Client({ region: process.env.S3_REGION ?? 'auto', endpoint: process.env.S3_ENDPOINT, forcePathStyle: !!process.env.S3_ENDPOINT });
const BUCKET = process.env.BACKUP_BUCKET ?? '';
const PREFIX = 'pg/';

export async function runBackup(now = new Date()) {
  const key = `${PREFIX}${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sql.gz`;

  const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '--format=plain', process.env.DATABASE_URL!], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  dump.stderr.on('data', (d) => (stderr += d.toString()));

  const body = new PassThrough();
  dump.stdout.pipe(createGzip({ level: 6 })).pipe(body);

  const exit = new Promise<number>((resolve) => dump.on('close', resolve));

  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/gzip' },
    partSize: 16 * 1024 * 1024,
    queueSize: 4,
  });

  const [code] = await Promise.all([exit, upload.done()]);
  if (code !== 0) {
    // The object was uploaded but it's a truncated dump: remove it, don't keep a lie.
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: key }] } }));
    throw new Error(`pg_dump exited ${code}: ${stderr.slice(-2000)}`);
  }

  const pruned = await applyRetention(now);
  return { key, pruned };
}

export function keepSet(keys: { key: string; date: Date }[], now: Date, policy = { daily: 14, weekly: 8, monthly: 12 }) {
  const keep = new Set<string>();
  const sorted = [...keys].sort((a, b) => b.date.getTime() - a.date.getTime());

  const pick = (bucketOf: (d: Date) => string, limit: number) => {
    const seen = new Set<string>();
    for (const k of sorted) {
      const b = bucketOf(k.date);
      if (seen.has(b)) continue;
      seen.add(b);
      keep.add(k.key);
      if (seen.size >= limit) break;
    }
  };

  pick((d) => d.toISOString().slice(0, 10), policy.daily);
  pick((d) => isoWeek(d), policy.weekly);
  pick((d) => d.toISOString().slice(0, 7), policy.monthly);

  // Never delete anything younger than 48h, whatever the policy says.
  for (const k of keys) if (now.getTime() - k.date.getTime() < 48 * 3600_000) keep.add(k.key);
  return keep;
}

async function applyRetention(now: Date) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
  const keys = (list.Contents ?? []).filter((o) => o.Key && o.LastModified).map((o) => ({ key: o.Key!, date: o.LastModified! }));
  const keep = keepSet(keys, now);
  const drop = keys.filter((k) => !keep.has(k.key));
  if (drop.length) {
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: drop.map((d) => ({ Key: d.key })) } }));
  }
  return drop.length;
}

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}
