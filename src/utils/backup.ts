import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, BUCKET_NAME } from '../config/minio';
import { UsageEvent } from '../api/schemas';

/**
 * Backup raw events to MinIO (S3-compatible storage)
 *
 * Stores events as JSON files organized by date:
 * /events/YYYY/MM/DD/batch_{timestamp}_{random}.json
 *
 * This provides:
 * - Disaster recovery (replay from raw data)
 * - Audit trail (immutable record of what was received)
 * - Reprocessing capability (schema changes, bug fixes)
 */
export async function backupEvents(events: UsageEvent[]): Promise<string> {
  if (events.length === 0) {
    return '';
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const timestamp = now.getTime();
  const random = Math.random().toString(36).substring(2, 8);

  const key = `events/${year}/${month}/${day}/batch_${timestamp}_${random}.json`;

  const body = JSON.stringify({
    backed_up_at: now.toISOString(),
    event_count: events.length,
    events: events,
  });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    })
  );

  return key;
}
