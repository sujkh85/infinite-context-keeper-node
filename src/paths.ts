import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 패키지 루트 (컴파일 후 dist/ 기준 상위). */
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
