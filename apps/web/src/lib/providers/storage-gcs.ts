// 生产存储：Google Cloud Storage。bucket 必须建在加拿大区（northamerica-northeast1/2）
// 以满足 PIPEDA 数据驻留（DEV-PLAN §7）。Cloud Run 上走 ADC，无需密钥文件。
import { Storage } from "@google-cloud/storage";
import type { StorageProvider } from "./storage";

export class GcsStorageProvider implements StorageProvider {
  readonly name = "gcs";
  private bucket;

  constructor(bucketName: string, projectId?: string) {
    this.bucket = new Storage(projectId ? { projectId } : {}).bucket(bucketName);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    await this.bucket.file(key).save(Buffer.from(bytes), {
      contentType,
      resumable: false, // 单据都是小文件，一次性写入更省往返
    });
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    const [buf] = await this.bucket.file(key).download();
    return new Uint8Array(buf);
  }

  async exists(key: string): Promise<boolean> {
    const [ok] = await this.bucket.file(key).exists();
    return ok;
  }
}
