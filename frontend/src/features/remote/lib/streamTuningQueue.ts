/** Serializes requests and skips superseded work, with three bounded attempts. */
export class StreamTuningQueue {
  private tail: Promise<void> = Promise.resolve();
  enqueue(send: (signal: AbortSignal) => Promise<unknown>, failed: () => void): () => void {
    let active = true;
    let controller: AbortController | undefined;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.tail = this.tail.then(async () => {
      for (let attempt = 0; active && attempt < 3; attempt++) {
        controller = new AbortController();
        const deadline = setTimeout(() => controller?.abort(), 5000);
        try {
          await send(controller.signal);
          return;
        } catch {
          if (!active) return;
          if (attempt === 2) {
            failed();
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, 500 * 2 ** attempt);
          });
        } finally {
          clearTimeout(deadline);
        }
      }
    });
    return () => {
      active = false;
      controller?.abort();
      clearTimeout(timer);
      wake?.();
    };
  }
}
