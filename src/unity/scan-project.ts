import { readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { existsSync, statSync } from "node:fs";

const SKIP_DIRS = new Set([
  "Library",
  "Temp",
  "obj",
  "Logs",
  ".git",
  "node_modules",
  "Packages",
  "Build",
  "build",
]);

const UNITY_EXT = new Set([
  ".cs",
  ".unity",
  ".prefab",
  ".asset",
  ".shader",
  ".anim",
  ".controller",
  ".uxml",
  ".uss",
  ".asmdef",
]);

export type ScannedUnityFile = {
  rel_path: string;
  kind: string;
  mtime_ms: number | null;
};

/**
 * Unity 프로젝트 루트를 스캔해 인덱싱할 파일 목록을 만듭니다.
 * `Assets`가 있으면 그 아래만, 없으면 루트에서 Library 등은 건너뜁니다.
 */
export async function scanUnityProjectFiles(
  projectRoot: string,
  maxFiles: number,
): Promise<ScannedUnityFile[]> {
  const max = Math.max(1, Math.min(maxFiles, 50_000));
  const root = projectRoot;
  const startDirs: string[] = [];
  const assets = join(root, "Assets");
  if (existsSync(assets) && statSync(assets).isDirectory()) {
    startDirs.push(assets);
  } else {
    startDirs.push(root);
  }

  const out: ScannedUnityFile[] = [];
  const stack = [...startDirs];

  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= max) break;
      const name = String(e.name);
      const full = join(dir, name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!UNITY_EXT.has(ext)) continue;
        let mtime_ms: number | null = null;
        try {
          mtime_ms = Math.trunc(statSync(full).mtimeMs);
        } catch {
          mtime_ms = null;
        }
        const rel = relative(root, full).replace(/\\/g, "/");
        out.push({ rel_path: rel, kind: ext.slice(1) || "file", mtime_ms });
      }
    }
  }

  return out;
}
