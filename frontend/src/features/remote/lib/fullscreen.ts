// Fullscreen API with the vendor-prefixed fallbacks older Safari / Firefox still need.

export function requestViewportFullscreen(el: HTMLElement): Promise<void> {
  const anyEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => void;
    mozRequestFullScreen?: () => void;
  };
  if (typeof el.requestFullscreen === "function") return el.requestFullscreen();
  if (typeof anyEl.webkitRequestFullscreen === "function") {
    anyEl.webkitRequestFullscreen();
    return Promise.resolve();
  }
  if (typeof anyEl.mozRequestFullScreen === "function") {
    anyEl.mozRequestFullScreen();
    return Promise.resolve();
  }
  return Promise.resolve();
}

export function exitViewportFullscreen(): Promise<void> {
  const doc = document as Document & {
    webkitExitFullscreen?: () => void;
    mozCancelFullScreen?: () => void;
  };
  if (typeof document.exitFullscreen === "function") return document.exitFullscreen();
  if (typeof doc.webkitExitFullscreen === "function") {
    doc.webkitExitFullscreen();
    return Promise.resolve();
  }
  if (typeof doc.mozCancelFullScreen === "function") {
    doc.mozCancelFullScreen();
    return Promise.resolve();
  }
  return Promise.resolve();
}
