# Infinite Context Keeper (Node.js)

## English

**Infinite Context Keeper** is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It exposes tools for **context usage estimation** (tiktoken-style counting), **conversation compaction** (metadata in **SQLite**), and **durable memory** with **semantic search** and injection using **local embeddings** (`@xenova/transformers`, stored in SQLite). Memory stores share **one opened `DatabaseSync`** connection from startup for consistency and to avoid SQLite file-lock issues. **`@xenova/transformers`** and **`sqlite-vec`** load **lazily** when embeddings are first needed (or stay unloaded if embeddings are disabled), which reduces startup time and memory. It also includes a **Project Brain** layer: milestones, tasks, decisions, knowledge, and a Unity-oriented **file index** in the same database, plus MCP tools to query and resume work across sessions. When supported by the runtime, **sqlite-vec** (`vec0`) accelerates semantic memory KNN search; otherwise the server falls back to in-process cosine similarity.

**npm:** [infinite-context](https://www.npmjs.com/package/infinite-context) · **source:** [infinite-context-keeper-node](https://github.com/sujkh85/infinite-context-keeper-node)

### Requirements

- Node.js **22.5+** (uses `node:sqlite`)
- **sqlite-vec** (optional, recommended): Node **23.5+** with `DatabaseSync(..., { allowExtension: true })` so the bundled `sqlite-vec` extension loads; on older Node or if loading fails, semantic search still works via **JavaScript cosine** on stored embeddings. The extension is **not** loaded at process start unless and until the semantic path needs it (**lazy**).
- When **embeddings are enabled**, the first use of the embedder may download models (e.g. `Xenova/all-MiniLM-L6-v2`) into the Hugging Face cache (loading is **lazy**, not at server boot).
- Optional: **OpenAI-compatible** API key for compaction

### Install & run

**Recommended (avoids global npm permission issues):**

```bash
npx -y infinite-context
```

Global install:

```bash
npm install -g infinite-context
infinite-context
```

#### macOS and permission errors (`EACCES`)

On MacBooks and other Macs, `npm install -g` often fails with `EACCES` when npm’s global prefix (for example `/usr/local`) is owned by root or not writable by your user. **Prefer `npx`** so you do not need a global install.

To use a global CLI without `sudo`, install npm’s global packages under your home directory:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
# Then add this line to ~/.zshrc or ~/.bash_profile and restart the shell:
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g infinite-context
```

Using `sudo` works but can leave **root-owned** files under the global prefix and cause more permission errors later; use it only if the approaches above are not possible:

```bash
sudo npm install -g infinite-context
sudo infinite-context
```

#### Where data is stored

By default, runtime data goes under `./data` **relative to the process current working directory** (SQLite file e.g. `./data/infinite_context_keeper.sqlite`). MCP hosts should set **`cwd`** to the project (for example Cursor’s `"${workspaceFolder}"`), or set **`ICK_DATA_DIR`** / YAML **`data_dir`** to an **absolute path** so the database is created in a predictable, writable place.

Check help/version:

```bash
npx -y infinite-context --help
npx -y infinite-context --version
```

From a git checkout: `npm install && npm run build`, then `node dist/index.js`. CLI aliases: `infinite-context` and `infinite-context-keeper`.

If local embeddings fail to start (for example errors loading native helpers used by `@xenova/transformers`), reinstall dependencies **on the same machine and architecture** (`rm -rf node_modules && npm install`) so optional native modules match your Mac (Apple Silicon vs Intel).

### Configuration (short)

1. Defaults ship in `config/default.yaml` (relative to the package root when installed from npm).
2. Point **`ICK_SETTINGS_YAML`** at your own YAML (**absolute path**) for per-project overrides.
3. Any setting can be overridden with **`ICK_` + SNAKE_UPPER** env vars (e.g. `ICK_OPENAI_API_KEY`).
4. **`default_project_id`** in YAML or **`ICK_DEFAULT_PROJECT_ID`** selects the default `project_id` for Project Brain tools when the tool omits `project_id` (default string: `default`).
5. **`ICK_DATA_DIR`** or YAML **`data_dir`** sets the directory for SQLite and runtime files. Use an **absolute path** when the process cwd is unpredictable (recommended for some MCP configs); otherwise `./data` is resolved from cwd.
6. **`embedding_enabled`** in YAML or **`ICK_EMBEDDING_ENABLED`** — when `false`, semantic tools (`save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `memory_search`, etc.) return an error stating that embeddings are disabled; **`search_and_inject_memory`** falls back to simple text chunking **without** semantic ranking; injected context blocks omit semantic-memory sections.

### Tools

**Diagnostics:** `get_server_info` — runtime snapshot: package version (from npm metadata), Node version, OS/arch, resolved **`data_dir`**, **`embedding_enabled`**, configured embedding model name, **`sqlite_vec_active`**, whether the embedder pipeline has been loaded (`embedder_loaded`), **`default_project_id`**, and whether **`ICK_SETTINGS_YAML`** was set.

**Context & memory:** `get_context_usage`, `trigger_compaction`, `save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `search_and_inject_memory`, `list_memories`, `delete_memory`.

**Project Brain:** `project_get_status`, `project_create_milestone`, `task_break_down`, `task_update`, `unity_scan_project`, `memory_search`, `project_resume` (structured state, Unity file index, and a markdown **`inject_block`** for cold starts).

**Danger / maintenance:** `reset_entire_database` — **irrecoverably** deletes all user rows in `infinite_context_keeper.sqlite` (memories, compaction tables, `semantic_memories` and optional sqlite-vec side tables, Project Brain tables, `project_files`). The MCP tool runs only when `confirm` is exactly **`DELETE_ALL_DATA`**. It does **not** remove on-disk session archive folders under `data_dir`; delete those separately if needed.

Tool list responses are de-duplicated by tool name on the server side.

`semantic_search_memory` and `memory_search` responses include **`sqlite_vec_knn`**: `true` when sqlite-vec is loaded and semantic rows use the `vec0` KNN path; `false` when the server uses the JavaScript cosine fallback.

### Long-running agent rules

For multi-session execution on the same project, paste and use the block below in Cursor Rules, `AGENTS.md`, or a system prompt.

```text
You are a long-running agent that actively uses the "Infinite Context" MCP.

The project goal is defined in goal.md.
The core principle is "do not stop after the first task"; if at least one task remains, you must continue with the next one.

Rules:
1. At the start of every session, you must inspect the current state through Infinite Context.
   - Use **project_resume(project_id?, session_id?)** first to gather Project Brain summary, `inject_block`, recent compaction, and top semantic chunks.
   - Use **project_get_status(project_id?)** to check milestones, tasks, and index status.
   - Use list_memories(project_id, session_id) to review recent compaction metadata and summary flow.
   - Use semantic_search_memory, **memory_search**, and inject_relevant_memories to find "in-progress work", "blockers", "next steps", and prior decisions/knowledge.
   - If needed, use search_and_inject_memory(task_description, project_id, session_id) to get an injection block tailored to this session's goal.
   - Use get_context_usage(max_tokens, …) regularly to monitor context usage.

2. Enforce the work loop. (Critical)
   - Always run in this cycle: "select next incomplete task -> execute -> verify -> save memory -> select next task".
   - Never stop while incomplete tasks exist.
   - "report-only then stop" is forbidden; complete real changes/verification/recording, then immediately move to the next task.
   - Stopping is allowed only when all goals and tasks defined in goal.md are complete.

3. Run forced handoff at 75% context usage. (Critical)
   - If usage ratio from get_context_usage reaches 75% or higher, start handoff immediately.
   - With save_memory, store these fields in structured form: current progress, completed/incomplete tasks, failure causes, next action, restart checklist.
   - Call trigger_compaction(project_id, session_id, conversation_text or messages, with custom_instruction explicitly saying "preserve project goals, goal.md essentials, and incomplete tasks").
   - Add/sync remaining work in Infinite Context, then continue in a new session (new window) using project_resume.
   - Right after handoff, the new session must read saved next_steps and resume from the next incomplete task immediately.

4. Recording rules during execution:
   - Always follow goal.md.
   - Save important decisions, progress, and failure/retry outcomes with save_memory(key, content, project_id, session_id, optional metadata).
   - Keep milestone/task DB state in sync using **project_create_milestone**, **task_break_down** (re-call with tasks array), and **task_update**.
   - In Unity workspaces, refresh file index with **unity_scan_project**.

5. Mandatory steps before session end:
   - Save next_steps as an actionable checklist via save_memory.
   - Include keywords so the next session can immediately continue via semantic_search_memory or search_and_inject_memory.
   - Do not repeat already-compacted content; continue briefly based on Keeper summaries/memories.

6. Deliverable report format (Required):
   - **Code changes**: modified/created files and key logic
   - **Why this changed**: necessity and technical rationale
   - **Test/verification results**: actual logs/outputs checked
   - **Next step proposal**: immediately executable follow-up task

Now read goal.md, analyze the full project goal, and do not stop at only the first task; continue executing as far as completion is possible in sequence.
If all work is complete, define new goals or tasks, persist them in Infinite Context (milestones/tasks/memories), and repeat the work loop.
```

### License

MIT (see `package.json`).

### Changelog (recent releases)

Derived from git history:

- **0.1.8** — Shared SQLite connection for memory stores; lazy loading of transformers / sqlite-vec; **`get_server_info`** diagnostic tool; degradation when **`embedding_enabled`** is false; MCP server **`version`** field reads the installed package version (not a hardcoded constant).
- **0.1.7** — CLI **`--help`** / **`--version`** for the `infinite-context` binary.
- **0.1.6** — **`reset_entire_database`** maintenance tool (`confirm: DELETE_ALL_DATA`).
- **0.1.5** — **`delete_memory`** tool.
- **0.1.4+** — README updates; MCP tool list **de-duplicated** by name on the server.

**More detail** — Cursor / Claude `mcp.json` samples and the Python vs Node comparison table are in the **한국어** section below.

---

## 한국어

**Infinite Context Keeper**는 Model Context Protocol(MCP) 서버입니다. 대화 컨텍스트 사용량 조회, compaction, 장기 메모 저장·시맨틱 검색·주입을 도구로 제공합니다. compaction 메타와 시맨틱 메모는 **같은 SQLite DB**에 두며, **메모리 스토어는 시작 시 열린 `DatabaseSync` 하나를 공유**해 잠금·일관성 문제를 줄입니다. 시맨틱 행은 **`semantic_memories`**와 **로컬 임베딩(@xenova/transformers)** 으로 저장하며, **`@xenova/transformers`**·**`sqlite-vec`** 는 **첫 필요 시점에 지연 로드**(임베딩이 꺼져 있으면 로드 생략)되어 기동 시간·메모리를 줄입니다. **Project Brain**으로 `projects` / `milestones` / `tasks` / `decisions` / `knowledge` / **`project_files`(Unity 스캔 인덱스)** 등을 같은 DB에서 관리하고, 세션 재개용 **`project_resume`** 등 MCP 도구로 읽고 갱신할 수 있습니다. 런타임이 허용하면 **`sqlite-vec`(vec0)** 으로 시맨틱 메모 KNN 검색을 가속하고, 아니면 **JS 코사인**으로 폴백합니다.

npm: [infinite-context](https://www.npmjs.com/package/infinite-context)

### 요구 사항

- Node.js **22.5+** (`node:sqlite` 사용)
- **sqlite-vec**(선택·권장): Node **23.5+**에서 확장 로드가 되면 시맨틱 KNN에 사용합니다. 아니면 **JS 코사인**입니다. 확장은 기동 직후가 아니라 **필요할 때 지연 로드**됩니다.
- 임베딩이 켜져 있을 때, 첫 사용 시 Hugging Face 캐시로 `Xenova/all-MiniLM-L6-v2` 등이 내려받아질 수 있음(서버 부팅 시가 아니라 **지연 로드**)
- (선택) compaction LLM: **OpenAI 호환 API** 키

### 설치 (npm)

**권장:** 전역 설치 없이 실행(맥에서 `EACCES` 회피에 유리):

```bash
npx -y infinite-context
```

전역 CLI:

```bash
npm install -g infinite-context
```

#### macOS·권한 오류 (`EACCES`)

맥북 등 macOS에서는 npm 전역 prefix(예: `/usr/local`)가 현재 사용자에게 쓰기 불가면 `npm install -g`가 `EACCES`로 실패합니다. 가능하면 **`npx`로만 실행**하는 것을 권장합니다.

`sudo` 없이 전역 CLI를 쓰려면 홈 디렉터리 아래에 전역 패키지를 두고 `PATH`만 잡습니다:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
# 아래 한 줄을 ~/.zshrc 또는 ~/.bash_profile에 넣은 뒤 셸을 다시 여세요:
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g infinite-context
```

`sudo npm install -g`는 동작할 수 있으나 전역 디렉터리에 **root 소유 파일**이 남아 이후에도 권한 문제가 반복되기 쉽습니다. 위 방법이 어려울 때만 사용하세요:

```bash
sudo npm install -g infinite-context
sudo infinite-context
```

#### 데이터 저장 위치

기본값 `./data`는 **프로세스 시작 시 현재 작업 디렉터리(cwd)** 기준입니다(SQLite 예: `./data/infinite_context_keeper.sqlite`). Cursor 등 MCP에서는 **`cwd`를 프로젝트로 지정**(예: `"${workspaceFolder}"`)하거나, **`ICK_DATA_DIR`** 또는 YAML **`data_dir`**에 **절대 경로**를 두어 예측 가능한 위치에 DB가 생기게 하세요.

도움말/버전 확인:

```bash
npx -y infinite-context --help
npx -y infinite-context --version
```

로컬 클론에서 `@xenova/transformers` 관련 네이티브 모듈 오류가 나면, **같은 맥·같은 아키텍처**에서 `node_modules`를 다시 설치하세요(`rm -rf node_modules && npm install`).

### 소스에서 설치·빌드

```bash
git clone https://github.com/sujkh85/infinite-context-keeper-node.git
cd infinite-context-keeper-node
npm install
npm run build
```

### 설정

1. 기본값: 패키지에 포함된 `config/default.yaml` (npm 사용 시 패키지 루트 기준)
2. 사용자 YAML: 환경변수 **`ICK_SETTINGS_YAML`**에 파일 **절대 경로** (프로젝트별 설정에 권장)
3. 예시 키: 저장소의 `config/config.example.yaml` 참고

개별 설정은 환경변수 **`ICK_`** 접두사 + YAML 필드명의 스네이크 대문자(예: `openai_api_key` → `ICK_OPENAI_API_KEY`)로 덮어쓸 수 있습니다.

**데이터 디렉터리:** 환경변수 **`ICK_DATA_DIR`** 또는 YAML **`data_dir`**로 SQLite·런타임 파일 위치를 지정합니다. MCP 등에서 cwd가 매번 달라질 수 있으면 **절대 경로**를 권장합니다. 생략 시 `./data`는 **프로세스 cwd** 기준으로 해석됩니다.

**임베딩 끄기:** YAML **`embedding_enabled: false`** 또는 **`ICK_EMBEDDING_ENABLED=0`** 이면 시맨틱 전용 도구(`save_memory`, `semantic_search_memory` 등)는 비활성 안내 오류를 반환하고, **`search_and_inject_memory`** 는 시맨틱 순위 없이 텍스트 청크 위주로 동작하며, 컨텍스트 주입에서 시맨틱 메모 구간은 생략됩니다.

**Project Brain 기본 프로젝트:** YAML의 `default_project_id` 또는 환경변수 **`ICK_DEFAULT_PROJECT_ID`**로, 도구 인자에서 `project_id`를 생략했을 때 쓸 ID를 지정합니다(기본값 문자열 `default`).

### 실행 (stdio MCP)

전역 설치했다면:

```bash
infinite-context
```

전역 설치 없이:

```bash
npx -y infinite-context
```

맥에서 전역 설치·권한 문제는 위 **「설치 (npm)」** 절의 macOS·`EACCES`·데이터 경로 안내를 참고하세요.

런타임 데이터는 기본적으로 **`./data`**(cwd 기준)에 저장되며, SQLite 파일도 같은 위치에 생성됩니다(예: `./data/infinite_context_keeper.sqlite`).

(`infinite-context-keeper` 별칭도 동일 진입점입니다.)

소스 빌드 후:

```bash
node dist/index.js
```

### Claude Code 등록 예시

npm 패키지로 등록:

```bash
claude mcp add --transport stdio --scope project infinite-context -- \
  npx -y infinite-context
```

`.mcp.json` / Cursor MCP 예시(npm).

**최소 설정** — 패키지에 포함된 `config/default.yaml`만 쓰고, 환경 변수는 생략합니다. compaction에 OpenAI 호환 키가 필요하면 아래 확장 예시처럼 `ICK_OPENAI_API_KEY`만 추가하면 됩니다.

```json
{
  "mcpServers": {
    "infinite-context": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "infinite-context"]
    }
  }
}
```

SQLite·`data_dir` 기본값(`./data`)이 **현재 작업 디렉터리** 기준이므로, 데이터를 워크스페이스에 두고 싶다면 `cwd`만 더 넣습니다.

```json
{
  "mcpServers": {
    "infinite-context": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "infinite-context"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

**프로젝트 YAML·API 키까지 지정** — 워크스페이스의 설정 파일과 호스트 환경의 키를 넘길 때:

```json
{
  "mcpServers": {
    "infinite-context": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "infinite-context"],
      "cwd": "${workspaceFolder}",
      "env": {
        "ICK_SETTINGS_YAML": "${workspaceFolder}/config/config.example.yaml",
        "ICK_OPENAI_API_KEY": "${env:ICK_OPENAI_API_KEY}"
      }
    }
  }
}
```

로컬 `dist`를 쓰려면 `command`/`args`를 `node`와 `${workspaceFolder}/dist/index.js`로 바꾸면 됩니다.

### 노출 도구

**진단:** `get_server_info` — 패키지 버전·Node·OS/arch·해석된 `data_dir`·`embedding_enabled`·임베딩 모델명·sqlite-vec 활성·임베더 로드 여부·`default_project_id`·`ICK_SETTINGS_YAML` 설정 여부 등.

**컨텍스트·메모리:** `get_context_usage`, `trigger_compaction`, `save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `search_and_inject_memory`, `list_memories`, `delete_memory`.

**Project Brain:** `project_get_status`, `project_create_milestone`, `task_break_down`, `task_update`, `unity_scan_project`, `memory_search`, `project_resume`.

**위험·유지보수:** `reset_entire_database` — `infinite_context_keeper.sqlite` 안의 **사용자 데이터 행을 전부 삭제**합니다(복구 불가). 대상: 메모·컴팩션 메타·시맨틱 메모(및 sqlite-vec 보조 테이블)·Project Brain·Unity 인덱스 등. MCP에서는 `confirm`이 정확히 **`DELETE_ALL_DATA`** 일 때만 실행됩니다. **`data_dir` 아래 세션 아카이브 폴더**는 SQLite 밖이라 이 도구로 지우지 않습니다. 필요하면 파일 시스템에서 별도 삭제하세요.

도구 목록 응답은 서버에서 tool name 기준으로 중복 제거해서 반환합니다.

| 도구 | 요약 |
|------|------|
| `get_server_info` | 런타임 진단(버전, Node, data_dir, embedding·sqlite-vec·임베더 상태 등) |
| `project_get_status` | 프로젝트·마일스톤·태스크·최근 결정/지식·인덱스된 Unity 파일 수 요약 |
| `project_create_milestone` | 마일스톤 추가(`order_num` 자동) |
| `task_break_down` | `tasks` 배열 없으면 분해 안내만 반환; 채워서 재호출 시 태스크 일괄 삽입 |
| `task_update` | 태스크 상태·노트(설명에 타임스탬프)·`actual_hours` 가산 |
| `unity_scan_project` | Unity 루트 스캔 후 `project_files` 갱신(기본 `cwd`) |
| `memory_search` | 시맨틱 메모 + 결정/지식 텍스트 혼합 검색 |
| `project_resume` | 새 세션용 `inject_block`(마크다운)·구조화 데이터·compaction 힌트·시맨틱 상위 청크 |
| `delete_memory` | `save_memory`로 저장된 시맨틱 메모를 `id` 또는 (`project_id`,`session_id`,`key`)로 삭제 |
| `reset_entire_database` | 로컬 SQLite **전 테이블 사용자 데이터** 삭제(복구 불가). 인자 `confirm: "DELETE_ALL_DATA"` 필수 |

`semantic_search_memory` / `memory_search` 응답의 **`sqlite_vec_knn`**: 시맨틱 행에 대해 sqlite-vec KNN 경로가 켜졌는지 여부입니다.

### 장기 컨텍스트 유지 (에이전트 지침)

여러 채팅 세션에 걸쳐 같은 프로젝트를 이어갈 때, Cursor **Rules**·**AGENTS.md**·시스템 프롬프트 등에 아래 지침을 붙여 두면 Infinite Context Keeper MCP로 **진행 상황·결정·다음 할 일**을 DB에 남기고, 새 세션에서 다시 주입할 수 있습니다.  
`project_id`·`session_id`는 프로젝트마다 **고정 문자열**으로 쓰는 것을 권장합니다(예: `project_id: "my-app"`, `session_id: "main"`).

아래 블록은 저장소에 실제로 노출된 **도구 이름**과 맞춰 두었습니다.

```text
너는 "Infinite Context" MCP를 적극적으로 사용하는 장기 실행 에이전트다.

프로젝트 목표는 goal.md 파일에 정의되어 있다.
핵심 원칙은 "첫 작업 후 종료 금지"이며, 남은 작업이 1개라도 있으면 반드시 다음 작업을 계속 수행한다.

규칙:
1. 매 세션 시작 시 반드시 Infinite Context로 현재 상태를 파악한다.
   - **project_resume(project_id?, session_id?)** 로 Project Brain 요약, `inject_block`, 최근 compaction, 시맨틱 상위 청크를 우선 수집한다.
   - **project_get_status(project_id?)** 로 마일스톤, 태스크, 인덱스 상태를 확인한다.
   - list_memories(project_id, session_id)로 최근 compaction 메타 및 요약 흐름을 확인한다.
   - semantic_search_memory, **memory_search**, inject_relevant_memories로 "진행 중 작업", "블로커", "다음 단계", 과거 결정/지식을 검색한다.
   - 필요 시 search_and_inject_memory(task_description, project_id, session_id)로 이번 세션 목적에 맞는 주입 블록을 받는다.
   - get_context_usage(max_tokens, …)로 컨텍스트 사용량을 수시 확인한다.

2. 작업 루프를 강제한다. (중요)
   - 항상 "다음 미완료 태스크 선택 -> 실행 -> 검증 -> 메모리 저장 -> 다음 태스크 선택" 순환으로 동작한다.
   - 미완료 태스크가 존재하면 절대 종료하지 않는다.
   - "보고만 하고 종료"는 금지하며, 실제 변경/검증/기록까지 완료한 뒤 즉시 다음 태스크로 넘어간다.
   - 종료는 goal.md 상의 목표와 태스크가 모두 완료된 경우에만 허용된다.

3. 컨텍스트 75% 도달 시 강제 handoff 절차를 수행한다. (중요)
   - get_context_usage 기준 사용 비율이 75% 이상이면 즉시 handoff 준비를 시작한다.
   - save_memory로 반드시 아래 항목을 구조화해 저장한다: 현재 진행 상태, 완료/미완료 태스크, 실패 원인, 다음 액션, 재시작 체크리스트.
   - trigger_compaction(project_id, session_id, conversation_text 또는 messages, custom_instruction에 "프로젝트 목표와 goal 핵심, 미완료 태스크를 보존" 명시)을 호출한다.
   - Infinite Context에 남은 일을 추가/동기화한 뒤, 새 세션(새 창)에서 project_resume으로 이어서 작업한다.
   - handoff 직후 새 세션은 저장된 next_steps를 즉시 읽고 다음 미완료 태스크부터 재개한다.

4. 작업 수행 중 기록 규칙:
   - goal.md를 항상 준수한다.
   - 중요한 결정, 진행 상황, 실패/재시도 결과를 save_memory(key, content, project_id, session_id, metadata 선택)로 저장한다.
   - 마일스톤/태스크는 **project_create_milestone**, **task_break_down**(tasks 배열로 재호출), **task_update**로 DB 상태와 동기화한다.
   - Unity 워크스페이스면 **unity_scan_project**로 파일 인덱스를 갱신한다.

5. 세션 종료 직전 필수 처리:
   - save_memory로 next_steps를 실행 가능한 체크리스트 형태로 남긴다.
   - 다음 세션이 semantic_search_memory 또는 search_and_inject_memory로 즉시 이어질 수 있게 키워드를 포함한다.
   - 이전 세션에서 정리된 내용은 반복하지 말고, Keeper 요약/메모를 전제로 짧게 이어간다.

6. 산출물 보고 형식(필수):
   - **코드 변경**: 수정/생성 파일 및 주요 로직
   - **변경 이유 요약**: 필요성 및 기술적 근거
   - **테스트/검증 결과**: 실제 확인 로그/출력
   - **다음 단계 제안**: 연속 실행 가능한 다음 작업

지금 goal.md를 읽고 전체 목표를 분석한 뒤, 첫 번째 작업만 제시하지 말고 완료 가능한 범위까지 연속적으로 작업을 수행하라.
만약 작업이 모두 완료되면 다시 목표나 task를 만들어서 infinite-context에 저장하고 작업을 다시 반복한다.
```

### Python과의 차이 요약

| 항목 | Python | Node |
|------|--------|------|
| 시맨틱 저장 | Chroma + sentence-transformers | SQLite `semantic_memories` + `@xenova/transformers` + (선택) **sqlite-vec** `vec0` KNN |
| MCP 런타임 | FastMCP | `@modelcontextprotocol/sdk` |
| 토큰 추정 | tiktoken | `@dqbd/tiktoken` (지원 인코딩 부분 집합; `o200k_base` 등은 내부적으로 `cl100k_base`로 매핑될 수 있음) |
| 프로젝트 상태 | (구현에 따름) | SQLite: Project Brain 테이블 + `project_files` |

### 최근 변경 이력 (git 기준)

- **0.1.8** — SQLite 연결 공유; transformers/sqlite-vec **지연 로드**; **`get_server_info`**; **`embedding_enabled: false`** 시 단계적 비활성화; MCP 서버 **버전**을 패키지에서 읽음.
- **0.1.7** — CLI **`--help`** / **`--version`**.
- **0.1.6** — **`reset_entire_database`** (`confirm: DELETE_ALL_DATA`).
- **0.1.5** — **`delete_memory`**.
- **0.1.4 이후** — README 정리·서버 측 도구 목록 **이름 기준 중복 제거**.

### 라이선스

MIT (`package.json` 기준).
