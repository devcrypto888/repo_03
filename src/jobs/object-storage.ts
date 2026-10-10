import { S3Client, ListObjectsV2Command, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'auto',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: !!process.env.S3_ENDPOINT,
});
const BUCKET = process.env.IMPORT_BUCKET ?? '';
const INBOX = 'inbox/';
const DONE = 'processed/';

export interface RemoteFile {
  key: string;
  size: number;
  lastModified: Date;
}

/** Oldest first so a backlog is processed in the order it was produced. */
export async function listPendingFiles(): Promise<RemoteFile[]> {
  const out: RemoteFile[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: INBOX, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (!o.Key || o.Key.endsWith('/') || !/\.(csv|txt)$/i.test(o.Key)) continue;
      out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime() || a.key.localeCompare(b.key));
}

export async function readFile(key: string, maxBytes = 50 * 1024 * 1024): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if ((res.ContentLength ?? 0) > maxBytes) throw new Error(`File too large: ${res.ContentLength} bytes`);
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error('Empty object body');
  return Buffer.from(bytes);
}

/**
 * "Move" = copy + delete (S3 has no rename). If the delete fails after the
 * copy, the file is imported again next run. That's harmless because row
 * upserts are hash-guarded.
 */
export async function markProcessed(key: string) {
  const dest = DONE + new Date().toISOString().slice(0, 10) + '/' + key.slice(INBOX.length);
  await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: dest, CopySource: `${BUCKET}/${encodeURIComponent(key)}` }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
