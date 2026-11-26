import type { WsEvent } from "@/api/types";

/**
 * A synthetic Windows-style file system for the demo, so the file browser can be exercised
 * (navigate, select, copy/move/rename/delete, upload, download) without a real device.
 * Every name and path here is invented; nothing is read from or written to any machine.
 */
interface DemoNode {
  dir: boolean;
  size: number;
  text?: string;
  children?: Map<string, DemoNode>;
}

const DRIVES_PATH = "__this_pc__";
const DEFAULT_PATH = "C:\\Users\\Demo\\Documents";
const CHUNK_DELAY_MS = 160;

const file = (size: number, text?: string): DemoNode => ({ dir: false, size, text });
const folder = (entries: Record<string, DemoNode> = {}): DemoNode => ({
  dir: true,
  size: 0,
  children: new Map(Object.entries(entries)),
});

function seedTree(): Map<string, DemoNode> {
  const note =
    "Planning notes\n\n- Rotate the shared kiosk passwords\n- Review the new URL categories\n- Schedule the agent update window\n";
  return new Map<string, DemoNode>([
    [
      "C:",
      folder({
        Users: folder({
          Demo: folder({
            Documents: folder({
              "Quarterly planning notes - final - reviewed by finance and operations (v12) - copy.txt":
                file(note.length, note),
              "Customer onboarding documents and signed agreements 2026-Q4": folder({
                "agreement-signed.pdf": file(482_113),
              }),
              Invoices: folder({ "2026-10.pdf": file(220_400), "2026-11.pdf": file(231_982) }),
              "readme.txt": file(54, "Demo file. Nothing here is real.\n"),
              "budget.xlsx": file(88_320),
              "backup-2026-11.zip": file(48_300_000),
              "photo-team-offsite.png": file(3_412_990),
              ".gitignore": file(12, "node_modules\n"),
              "desktop.ini": file(67),
            }),
            Downloads: folder({
              "installer.exe": file(112_400_000),
              "setup-notes.txt": file(31, "Install steps go here.\n"),
            }),
            Desktop: folder(),
          }),
        }),
        "Program Files": folder({
          "Vantyr Agent": folder({ "vantyr-agent.exe": file(14_200_000) }),
        }),
        Windows: folder({ "notepad.exe": file(201_216) }),
      }),
    ],
    ["D:", folder({ Archive: folder(), "old-projects.7z": file(912_000_000) })],
  ]);
}

function splitPath(path: string): string[] {
  return path.split("\\").filter(Boolean);
}

export interface DemoFsCommand {
  type?: string;
  path?: string;
  name?: string;
  src?: string;
  dst?: string;
  recursive?: boolean;
  request_id?: string;
  chunk_index?: number;
  total_chunks?: number;
  data?: string;
}

/** One in-memory file system per demo agent. */
export function createDemoFileSystem() {
  type Emit = (event: WsEvent) => void;
  const trees = new Map<string, Map<string, DemoNode>>();
  const uploads = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const treeFor = (agentId: string) => {
    let tree = trees.get(agentId);
    if (!tree) {
      tree = seedTree();
      trees.set(agentId, tree);
    }
    return tree;
  };

  const find = (tree: Map<string, DemoNode>, path: string): DemoNode | null => {
    const [drive, ...rest] = splitPath(path);
    if (!drive) return null;
    const key = [...tree.keys()].find((k) => k.toLowerCase() === drive.toLowerCase());
    let node: DemoNode | null | undefined = key ? tree.get(key) : null;
    for (const part of rest) {
      if (!node?.children) return null;
      const entry = [...node.children.keys()].find((k) => k.toLowerCase() === part.toLowerCase());
      node = entry ? node.children.get(entry) : null;
    }
    return node ?? null;
  };
  const parentOf = (tree: Map<string, DemoNode>, path: string) => {
    const parts = splitPath(path);
    const name = parts.pop() ?? "";
    return { parent: find(tree, parts.join("\\")), name };
  };
  const clone = (node: DemoNode): DemoNode => ({
    ...node,
    children: node.children
      ? new Map([...node.children].map(([k, v]) => [k, clone(v)]))
      : undefined,
  });

  const reply = (emit: Emit, agentId: string, cmd: DemoFsCommand, ok: boolean, error?: string) =>
    emit({
      event: "fs_op_result",
      agent_id: agentId,
      data: { request_id: cmd.request_id, ok, ...(error ? { error } : {}) },
    });

  const list = (emit: Emit, agentId: string, requested: string | undefined) => {
    const tree = treeFor(agentId);
    if (requested === DRIVES_PATH) {
      emit({
        event: "dir_list",
        agent_id: agentId,
        data: {
          path: DRIVES_PATH,
          items: [...tree.keys()].map((name) => ({ name: `${name}\\`, is_dir: true, size: 0 })),
        },
      });
      return;
    }
    const path = requested || DEFAULT_PATH;
    const node = find(tree, path);
    const items = node?.children
      ? [...node.children].map(([name, child]) => ({ name, is_dir: child.dir, size: child.size }))
      : [];
    emit({ event: "dir_list", agent_id: agentId, data: { path, items } });
  };

  const read = (emit: Emit, agentId: string, path: string) => {
    const node = find(treeFor(agentId), path);
    if (!node || node.dir) {
      emit({
        event: "file_chunk",
        agent_id: agentId,
        data: { path, data: "The system cannot find the file specified.", is_error: true },
      });
      return;
    }
    const bytes = new TextEncoder().encode(node.text ?? `Demo content for ${path}\n`);
    // Large files arrive as several chunks so the progress bar can be exercised.
    const total = node.size > 1_000_000 ? 10 : 1;
    const step = Math.ceil(bytes.length / total);
    for (let i = 0; i < total; i++) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        const slice = bytes.slice(i * step, (i + 1) * step);
        emit({
          event: "file_chunk",
          agent_id: agentId,
          data: {
            path,
            chunk_index: i,
            total_chunks: total,
            data: btoa(String.fromCharCode(...slice)),
          },
        });
      }, i * CHUNK_DELAY_MS);
      timers.add(timer);
    }
  };

  const write = (emit: Emit, agentId: string, cmd: DemoFsCommand) => {
    const path = cmd.path ?? "";
    const tree = treeFor(agentId);
    const key = `${agentId}|${path}`;
    const received = (uploads.get(key) ?? 0) + (cmd.data ? atob(cmd.data).length : 0);
    uploads.set(key, received);
    if ((cmd.chunk_index ?? 0) + 1 < (cmd.total_chunks ?? 1)) return;
    uploads.delete(key);
    const { parent, name } = parentOf(tree, path);
    if (parent?.children) parent.children.set(name, file(received));
    emit({
      event: "file_upload_result",
      agent_id: agentId,
      data: {
        path,
        ok: Boolean(parent?.children),
        ...(parent?.children ? {} : { error: "Path not found." }),
      },
    });
  };

  const operate = (emit: Emit, agentId: string, cmd: DemoFsCommand) => {
    const tree = treeFor(agentId);
    switch (cmd.type) {
      case "Mkdir": {
        const parent = find(tree, cmd.path ?? "");
        if (!parent?.children || !cmd.name)
          return reply(emit, agentId, cmd, false, "The folder could not be created.");
        if (parent.children.has(cmd.name))
          return reply(
            emit,
            agentId,
            cmd,
            false,
            "A file or folder with that name already exists.",
          );
        parent.children.set(cmd.name, folder());
        return reply(emit, agentId, cmd, true);
      }
      case "CopyPath":
      case "RenamePath": {
        const source = find(tree, cmd.src ?? "");
        const target = parentOf(tree, cmd.dst ?? "");
        if (!source || !target.parent?.children)
          return reply(emit, agentId, cmd, false, "The system cannot find the path specified.");
        if (target.parent.children.has(target.name))
          return reply(emit, agentId, cmd, false, "The destination already exists.");
        target.parent.children.set(target.name, cmd.type === "CopyPath" ? clone(source) : source);
        if (cmd.type === "RenamePath") {
          const from = parentOf(tree, cmd.src ?? "");
          from.parent?.children?.delete(
            [...(from.parent.children?.keys() ?? [])].find(
              (k) => k.toLowerCase() === from.name.toLowerCase(),
            ) ?? from.name,
          );
        }
        return reply(emit, agentId, cmd, true);
      }
      case "DeletePath": {
        const target = parentOf(tree, cmd.path ?? "");
        const key = [...(target.parent?.children?.keys() ?? [])].find(
          (k) => k.toLowerCase() === target.name.toLowerCase(),
        );
        const node = key ? target.parent?.children?.get(key) : null;
        if (!node || !key)
          return reply(emit, agentId, cmd, false, "The system cannot find the path specified.");
        if (node.dir && node.children?.size && !cmd.recursive)
          return reply(emit, agentId, cmd, false, "The folder is not empty.");
        target.parent?.children?.delete(key);
        return reply(emit, agentId, cmd, true);
      }
    }
  };

  return {
    /** Handles a `control` command; returns false for commands that are not file-system ones. */
    handle(emit: Emit, agentId: string, cmd: DemoFsCommand): boolean {
      const run = (fn: () => void) => {
        // Answer on a later tick, like a real round trip.
        const timer = setTimeout(() => {
          timers.delete(timer);
          fn();
        }, 120);
        timers.add(timer);
        return true;
      };
      switch (cmd.type) {
        case "ListDir":
          return run(() => list(emit, agentId, cmd.path));
        case "ReadFile":
          return run(() => read(emit, agentId, cmd.path ?? ""));
        case "WriteFileChunk":
          return run(() => write(emit, agentId, cmd));
        case "Mkdir":
        case "CopyPath":
        case "RenamePath":
        case "DeletePath":
          return run(() => operate(emit, agentId, cmd));
        default:
          return false;
      }
    },
    dispose() {
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
