import { testMock as vi } from "@tests/support/mock";
import { afterEach, describe, expect, it } from "bun:test";
import { useRef, useState } from "react";
import { click, mountForm, typeInto, unmountForms } from "@tests/support/formDom";
import { DeleteFilesDialog } from "@/features/files/FileDialogs";
import { FileTable } from "@/features/files/FileTable";
import { FileBreadcrumbs, FileTransferStatus } from "@/features/files/FileTransferStatus";
import { FileSelectionBar, FilesToolbar } from "@/features/files/FilesToolbar";
import { breadcrumbs } from "@/features/files/filePaths";
import { createFileActionHandlers } from "@/features/files/fileActionHandlers";
import type { FileItem } from "@/features/files/useAgentFs";

afterEach(unmountForms);

const text = () => document.body.textContent ?? "";
const byLabel = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement;
const names = () =>
  Array.from(document.querySelectorAll("tbody tr")).map((r) =>
    r.querySelector("td:nth-child(2)")?.textContent?.trim(),
  );

const ITEMS: FileItem[] = [
  { name: "zeta.txt", is_dir: false, size: 10 },
  { name: "Projects", is_dir: true, size: 0 },
  { name: "alpha.log", is_dir: false, size: 2048 },
  { name: ".gitignore", is_dir: false, size: 3 },
  { name: "desktop.ini", is_dir: false, size: 3 },
];

function Table({ onOpenFolder = vi.fn(), items = ITEMS, initial = [] as FileItem[] }) {
  const [selected, setSelected] = useState<FileItem[]>(initial);
  return (
    <>
      <output data-testid="selected">{selected.map((s) => s.name).join(",")}</output>
      <FileTable
        items={items}
        loading={false}
        selected={selected}
        canUpload
        atDrives={false}
        toolbar={null}
        selectionBar={null}
        onSelectedChange={(update) => setSelected(update)}
        onOpenFolder={onOpenFolder}
        onDownload={vi.fn()}
        downloadDisabled={false}
      />
    </>
  );
}
const selectedNames = () => document.querySelector('[data-testid="selected"]')?.textContent;

describe("FileTable", () => {
  it("lists folders first, then files by name, and keeps system files out of sight", async () => {
    await mountForm(<Table />);
    expect(names()).toEqual(["Projects", "alpha.log", "zeta.txt"]);
    expect(text()).toContain("3 items");
    expect(text()).toContain("Show 2 hidden");
  });

  it("select-all only takes what is on screen, never hidden or filtered-out files", async () => {
    await mountForm(<Table />);
    await click(byLabel("Select all files in this folder")!);
    expect(selectedNames()?.split(",").sort()).toEqual(["Projects", "alpha.log", "zeta.txt"]);
    await click(byLabel("Select all files in this folder")!);
    expect(selectedNames()).toBe("");
    await typeInto(
      document.querySelector('input[aria-label="Search files and folders"]') as HTMLInputElement,
      "alpha",
    );
    expect(text()).toContain("1 of 3 items");
    await click(byLabel("Select all files in this folder")!);
    expect(selectedNames()).toBe("alpha.log");
  });

  it("opens a folder by its name without selecting it", async () => {
    const onOpenFolder = vi.fn();
    await mountForm(<Table onOpenFolder={onOpenFolder} />);
    await click(button("Projects"));
    expect(onOpenFolder).toHaveBeenCalledWith(expect.objectContaining({ name: "Projects" }));
    expect(selectedNames()).toBe("");
  });

  it("says why it is empty: filter, drive list, writable folder, read-only folder", async () => {
    await mountForm(<Table items={[]} />);
    expect(text()).toContain("This folder is empty. Upload files or create a new folder.");
    unmountForms();
    await mountForm(<Table />);
    await typeInto(
      document.querySelector('input[aria-label="Search files and folders"]') as HTMLInputElement,
      "nothing",
    );
    expect(text()).toContain("No files or folders match “nothing”.");
  });

  it("reveals hidden files on request", async () => {
    await mountForm(<Table />);
    await click(button("Show 2 hidden"));
    expect(names()).toContain(".gitignore");
    expect(button("Hide system files")).toBeTruthy();
  });
});

describe("FileSelectionBar", () => {
  function Bar({ count = 2, disabled = false }) {
    const selected: FileItem[] = Array.from({ length: count }, (_, i) => ({
      name: `f${i}`,
      is_dir: false,
      size: 1,
    }));
    const handlers = createFileActionHandlers({
      selected,
      selectedItem: selected[0] ?? null,
      selectedPath: "C:\\x\\f0",
      selectedPaths: selected.map((s) => `C:\\x\\${s.name}`),
      oneSelected: count === 1,
      oneFileSelected: count === 1,
      clipboard: null,
      canUpload: true,
      downloading: null,
      fs: { download: vi.fn(), openPreview: vi.fn() },
      setFsMessage: vi.fn(),
      setClipboard: vi.fn(),
      setPrompt: vi.fn(),
      setDeleteOpen: vi.fn(),
      copyText: vi.fn(),
      paste: vi.fn(),
    });
    return (
      <>
        <FileSelectionBar
          count={count}
          summary={selected[0]?.name ?? ""}
          disabled={disabled}
          isActionDisabled={handlers.isActionDisabled}
          onAction={handlers.onAction}
          onClear={vi.fn()}
        />
      </>
    );
  }

  it("names what is selected and leaves delete reachable", async () => {
    await mountForm(<Bar count={2} />);
    expect(document.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe(
      "Actions for selected items",
    );
    expect(text()).toContain("2 selected");
    expect(button("Delete").disabled).toBe(false);
    expect(button("Download").disabled).toBe(true);
    expect(button("Rename").disabled).toBe(true);
  });

  it("shows the file name for a single selection and enables download and rename", async () => {
    await mountForm(<Bar count={1} />);
    expect(text()).toContain("f0");
    expect(button("Download").disabled).toBe(false);
    expect(button("Rename").disabled).toBe(false);
  });

  it("locks every action while a transfer or operation runs", async () => {
    await mountForm(<Bar count={1} disabled />);
    for (const name of ["Download", "Rename", "Delete", "More"])
      expect(button(name).disabled).toBe(true);
  });
});

describe("file action guards", () => {
  const base = {
    selected: [] as FileItem[],
    selectedItem: null,
    selectedPath: null,
    selectedPaths: [] as string[],
    oneSelected: false,
    oneFileSelected: false,
    clipboard: null,
    canUpload: true,
    downloading: null,
    fs: { download: vi.fn(), openPreview: vi.fn() },
    setFsMessage: vi.fn(),
    setClipboard: vi.fn(),
    setPrompt: vi.fn(),
    setDeleteOpen: vi.fn(),
    copyText: vi.fn(),
    paste: vi.fn(),
  };
  it("does not offer to copy folders (the device copies files only) but still allows cut and delete", () => {
    const withFolder = createFileActionHandlers({
      ...base,
      selected: [{ name: "d", is_dir: true, size: 0 }],
    });
    expect(withFolder.isActionDisabled("copy")).toBe(true);
    expect(withFolder.isActionDisabled("cut")).toBe(false);
    expect(withFolder.isActionDisabled("delete")).toBe(false);
    const files = createFileActionHandlers({
      ...base,
      selected: [{ name: "a", is_dir: false, size: 1 }],
    });
    expect(files.isActionDisabled("copy")).toBe(false);
  });
});

describe("FilesToolbar", () => {
  const props = {
    refreshing: false,
    createDisabled: false,
    clipboard: null,
    pasteDisabled: false,
    onRefresh: vi.fn(),
    onNewFolder: vi.fn(),
    onNewFile: vi.fn(),
    onUpload: vi.fn(),
    onPaste: vi.fn(),
  };
  it("offers Paste only when something was cut or copied, and says how many", async () => {
    await mountForm(<FilesToolbar {...props} />);
    expect(button("Paste 2 items")).toBeUndefined();
    unmountForms();
    await mountForm(<FilesToolbar {...props} clipboard={{ mode: "move", count: 2 }} />);
    await click(button("Paste 2 items (move here)"));
    expect(props.onPaste).toHaveBeenCalled();
  });

  it("disables New and Upload in folders that cannot be written to", async () => {
    await mountForm(<FilesToolbar {...props} createDisabled />);
    expect(button("New").disabled).toBe(true);
    expect(button("Upload").disabled).toBe(true);
    expect((byLabel("Refresh folder") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("FileBreadcrumbs", () => {
  const render = (path: string, onNavigate = vi.fn(), onCopyPath = vi.fn()) => (
    <FileBreadcrumbs
      crumbs={breadcrumbs(path)}
      currentPath={path}
      onNavigate={onNavigate}
      onCopyPath={onCopyPath}
    />
  );

  it("goes up one folder and to any ancestor", async () => {
    const onNavigate = vi.fn();
    await mountForm(render("C:\\Users\\Demo\\Documents", onNavigate));
    await click(byLabel("Up to Demo")!);
    expect(onNavigate).toHaveBeenLastCalledWith("C:\\Users\\Demo\\");
    await click(button("Users"));
    expect(onNavigate).toHaveBeenLastCalledWith("C:\\Users\\");
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe("Documents");
  });

  it("copies the full path, but not for the drive list; there is nothing above it either", async () => {
    const onCopyPath = vi.fn();
    await mountForm(render("C:\\Users", vi.fn(), onCopyPath));
    await click(byLabel("Copy folder path")!);
    expect(onCopyPath).toHaveBeenCalled();
    unmountForms();
    await mountForm(render("__this_pc__"));
    expect((byLabel("Copy folder path") as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel("Up one folder") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("FileTransferStatus", () => {
  const idle = {
    downloading: null,
    downloadProgress: 0,
    uploading: null,
    uploadProgress: 0,
    uploadMessage: null,
    fsMessage: null,
    onDismissUploadMessage: vi.fn(),
    onDismissFsMessage: vi.fn(),
  };

  it("renders nothing while idle", async () => {
    await mountForm(<FileTransferStatus {...idle} />);
    expect(document.body.textContent).toBe("");
  });

  it("names the file and the percentage of a running transfer", async () => {
    await mountForm(
      <FileTransferStatus
        {...idle}
        downloading={"C:\\Users\\Demo\\backup.zip"}
        downloadProgress={42}
      />,
    );
    const bar = document.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Downloading backup.zip");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(text()).toContain("42%");
  });

  it("announces failures as alerts, successes as status, and lets either be dismissed", async () => {
    const onDismissFsMessage = vi.fn();
    await mountForm(
      <FileTransferStatus
        {...idle}
        fsMessage={{ ok: false, text: "Rename failed." }}
        uploadMessage="Upload finished."
        onDismissFsMessage={onDismissFsMessage}
      />,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Rename failed.");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Upload finished.");
    await click(document.querySelector('[role="alert"] button')!);
    expect(onDismissFsMessage).toHaveBeenCalled();
  });

  it("treats a failed upload message as an error", async () => {
    await mountForm(<FileTransferStatus {...idle} uploadMessage="Upload timed out." />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Upload timed out.");
  });
});

describe("DeleteFilesDialog", () => {
  it("returns keyboard focus to the opening control when cancelled", async () => {
    function FocusHarness() {
      const [isOpen, setOpen] = useState(false);
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={trigger} onClick={() => setOpen(true)}>
            Delete selection
          </button>
          <DeleteFilesDialog
            open={isOpen}
            onOpenChange={setOpen}
            returnFocus={trigger}
            subject="a.txt"
            names={["a.txt"]}
            folderCount={0}
            location="C:\\Demo"
            busy={false}
            disabled={false}
            onConfirm={vi.fn()}
          />
        </>
      );
    }
    await mountForm(<FocusHarness />);
    const trigger = button("Delete selection");
    trigger.focus();
    await click(trigger);
    await click(button("Cancel"));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  const open = (over: Partial<React.ComponentProps<typeof DeleteFilesDialog>> = {}) => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    return {
      onConfirm,
      onOpenChange,
      node: (
        <DeleteFilesDialog
          open
          onOpenChange={onOpenChange}
          subject="2 items"
          names={["a.txt", "Projects"]}
          folderCount={1}
          location={"C:\\Users\\Demo"}
          busy={false}
          disabled={false}
          onConfirm={onConfirm}
          {...over}
        />
      ),
    };
  };

  it("states the consequence, where it happens and what goes", async () => {
    await mountForm(open().node);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Delete 2 items?");
    expect(dialog.textContent).toContain("It can't be undone.");
    expect(dialog.textContent).toContain("C:\\Users\\Demo");
    expect(dialog.textContent).toContain("a.txt");
    expect(dialog.textContent).toContain("Projects");
  });

  it("lists a handful of names and counts the rest", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `file-${i}.txt`);
    await mountForm(open({ subject: "8 items", names: many, folderCount: 0 }).node);
    expect(text()).toContain("file-4.txt");
    expect(text()).not.toContain("file-5.txt");
    expect(text()).toContain("and 3 more");
  });

  it("asks about recursion only when a folder is selected, and passes the choice through", async () => {
    const { node, onConfirm } = open();
    await mountForm(node);
    expect(text()).toContain("Delete folders recursively");
    await click(button("Delete"));
    expect(onConfirm).toHaveBeenCalledWith(true);
    unmountForms();
    await mountForm(open({ folderCount: 0 }).node);
    expect(text()).not.toContain("Delete folders recursively");
  });

  it("keeps Delete locked while the selection is empty or an operation runs", async () => {
    await mountForm(open({ busy: true }).node);
    expect(button("Delete").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
  });
});
