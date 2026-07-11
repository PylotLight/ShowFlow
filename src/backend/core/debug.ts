export const DEBUG = process.env.SHOWFLOW_DEBUG === 'true';

export function debugLog(message: string, ...args: any[]) {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    console.log(`[DEBUG ${timestamp}] ${message}`, ...args);
  }
}
