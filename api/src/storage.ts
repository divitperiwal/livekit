import { S3Client } from "bun";
import type { RecordingDeleter } from "./modules/calls/recording-retention";

export type RecordingStorageConfig = {
  RECORDING_S3_BUCKET: string;
  RECORDING_S3_REGION: string;
  RECORDING_S3_ENDPOINT: string;
  RECORDING_S3_ACCESS_KEY: string;
  RECORDING_S3_SECRET_KEY: string;
};

/** Recordings live in DigitalOcean Spaces (MinIO locally); this side only ever deletes. */
export function s3RecordingDeleter(config: RecordingStorageConfig): RecordingDeleter {
  const client = new S3Client({
    bucket: config.RECORDING_S3_BUCKET,
    region: config.RECORDING_S3_REGION,
    endpoint: config.RECORDING_S3_ENDPOINT,
    accessKeyId: config.RECORDING_S3_ACCESS_KEY,
    secretAccessKey: config.RECORDING_S3_SECRET_KEY,
  });
  return async (key) => {
    await client.delete(key);
  };
}
