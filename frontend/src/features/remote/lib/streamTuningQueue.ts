/** Serializes requests and skips superseded work, with three bounded attempts. */
export class StreamTuningQueue {
  private tail: Promise<void> = Promise.resolve();
  enqueue(send: () => Promise<unknown>, failed: () => void): () => void {
    let active = true;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.tail = this.tail.then(async () => {
      for (let attempt = 0; active && attempt < 3; attempt++) {
        try {
          await send();
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
        }
      }
    });
    return () => {
      active = false;
      clearTimeout(timer);
      wake?.();
    };
  }
}
