import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://localhost:9002';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'meterflow';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'meterflow123';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'meterflow-events';

export const s3Client = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: 'us-east-1', // Required but ignored by MinIO
  credentials: {
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  },
  forcePathStyle: true, // Required for MinIO
});

export const BUCKET_NAME = MINIO_BUCKET;

/**
 * Initialize MinIO: create bucket if it doesn't exist
 */
export async function initMinio(): Promise<void> {
  try {
    // Check if bucket exists
    await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    console.log(`MinIO bucket "${BUCKET_NAME}" exists`);
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      // Create bucket
      await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
      console.log(`MinIO bucket "${BUCKET_NAME}" created`);
    } else {
      throw error;
    }
  }
}
