export const shutdownController = new AbortController();

export function triggerShutdown(): void {
  if (!shutdownController.signal.aborted) {
    shutdownController.abort();
  }
}
