import { S3Client } from "bun";
import type { RecordingLinker } from "./modules/calls/recording-link";
import type { RecordingDeleter } from "./modules/calls/recording-retention";

export type RecordingStorageConfig = {
  RECORDING_S3_BUCKET: string;
  RECORDING_S3_REGION: string;
  RECORDING_S3_ENDPOINT: string;
  RECORDING_S3_ACCESS_KEY: string;
  RECORDING_S3_SECRET_KEY: string;
};

/** Recordings live in DigitalOcean Spaces (MinIO locally); the worker writes them. */
function recordingBucket(config: RecordingStorageConfig) {
  return new S3Client({
    bucket: config.RECORDING_S3_BUCKET,
    region: config.RECORDING_S3_REGION,
    endpoint: config.RECORDING_S3_ENDPOINT,
    accessKeyId: config.RECORDING_S3_ACCESS_KEY,
    secretAccessKey: config.RECORDING_S3_SECRET_KEY,
  });
}

/** The background process deletes recordings past retention. */
export function s3RecordingDeleter(config: RecordingStorageConfig): RecordingDeleter {
  const client = recordingBucket(config);
  return async (key) => {
    await client.delete(key);
  };
}

/** The api hands accounts signed download links; signing needs no network. */
export function s3RecordingLinker(config: RecordingStorageConfig): RecordingLinker {
  const client = recordingBucket(config);
  return (key, expiresInSeconds) =>
    client.presign(key, { method: "GET", expiresIn: expiresInSeconds });
}
