/**
 * Makes the Tauri settings UI feel like a desktop panel rather than a browser tab:
 * no arbitrary text selection, no in-page find, and other webview shortcuts are suppressed.
 * Text fields (inputs, textareas, contenteditable) still allow selection and editing.
 */

function isTextFieldTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof Element)) return false;
  const node = el.closest("input, textarea, select, [contenteditable='true']");
  if (!node) return false;
  if (node instanceof HTMLSelectElement) return true;
  if (node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLInputElement) {
    const t = node.type;
    if (
      t === "button" ||
      t === "submit" ||
      t === "reset" ||
      t === "checkbox" ||
      t === "radio" ||
      t === "file" ||
      t === "range" ||
      t === "color" ||
      t === "image"
    ) {
      return false;
    }
    return true;
  }
  return true;
}

function allowBrowserDevShortcuts(): boolean {
  return import.meta.env.DEV;
}

export function installNativeChrome(): void {
  const capture = true;

  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (allowBrowserDevShortcuts()) return;

      const mod = e.ctrlKey || e.metaKey;
      const inTextField = isTextFieldTarget(document.activeElement) || isTextFieldTarget(e.target);

      // Function keys that open find / refresh / devtools / fullscreen in Chromium
      if (
        e.key === "F3" ||
        e.key === "F5" ||
        e.key === "F7" ||
        e.key === "F11" ||
        e.key === "F12"
      ) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Select all only inside real text fields (not labels, status, headings).
      if (mod && (e.key === "a" || e.key === "A") && !inTextField) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (!mod) return;

      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Find / print / source / save / open / downloads / new tab+window / close tab
      if (k === "f" || k === "g" || k === "p" || k === "u" || k === "s" || k === "o" || k === "j") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (k === "n" || k === "t" || k === "w" || k === "r" || k === "l") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Devtools
      if (e.shiftKey && (k === "i" || k === "j" || k === "c")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Zoom (layout / text size)
      if (e.code === "Equal" || e.code === "Minus" || e.code === "Digit0") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    },
    capture,
  );

  document.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      if (allowBrowserDevShortcuts()) return;
      if (!isTextFieldTarget(e.target)) {
        e.preventDefault();
      }
    },
    capture,
  );

  document.addEventListener(
    "selectstart",
    (e: Event) => {
      if (allowBrowserDevShortcuts()) return;
      if (!isTextFieldTarget(e.target)) {
        e.preventDefault();
      }
    },
    capture,
  );
}

installNativeChrome();
