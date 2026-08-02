// P1 收单：原件存储抽象。dev 用本地磁盘；生产接加拿大区对象存储（PIPEDA）。
// 上层只依赖 StorageProvider 接口，切换实现不动业务代码（契约「Provider 抽象」）。
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GcsStorageProvider } from "./storage-gcs";

export interface StorageProvider {
  readonly name: string;
  /** 写入并返回 storageKey（落 Document.storageKey）。 */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
}

// dev：写到项目下 .storage/（已随 .env 一并 gitignore，勿提交真实文件）。
export class LocalDiskStorageProvider implements StorageProvider {
  readonly name = "local-disk";
  private base: string;

  constructor(baseDir = process.env.LOCAL_STORAGE_DIR ?? ".storage") {
    this.base = resolve(baseDir);
  }

  private path(key: string): string {
    // 防目录穿越：key 里的 .. 段剔除
    const safe = key.split("/").filter((s) => s && s !== "..").join("/");
    return join(this.base, safe);
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<string> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}

let cached: StorageProvider | null = null;

// 选择实现：配了 GCS_BUCKET 走 GCS，否则本地磁盘（仅 dev）。
// ⛔ 生产强制 GCS：Cloud Run 容器文件系统是临时的，实例回收即丢原件。
export function getStorageProvider(): StorageProvider {
  if (cached) return cached;
  const bucket = process.env.GCS_BUCKET;
  if (bucket) {
    cached = new GcsStorageProvider(bucket, process.env.GCP_PROJECT_ID);
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("生产环境必须配置 GCS_BUCKET：本地磁盘存储会随实例回收丢失原件");
    }
    cached = new LocalDiskStorageProvider();
  }
  return cached;
}

// 测试/多租户场景可注入替身（与 OCR/Classifier factory 一致）。
export function setStorageProvider(p: StorageProvider | null): void {
  cached = p;
}

// 生成存储 key：按客户/日期分目录，避免单目录爆量。
export function storageKeyFor(clientId: string, fileHash: string, fileName: string): string {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
  const day = new Date().toISOString().slice(0, 10);
  return `${clientId}/${day}/${fileHash}${ext}`;
}
