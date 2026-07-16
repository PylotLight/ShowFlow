export interface DownloadClient {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
