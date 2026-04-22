# Infinite Context Keeper (Node.js)

## English

**Infinite Context Keeper** is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It exposes tools for **context usage estimation** (tiktoken-style counting), **conversation compaction** (metadata in **SQLite**), and **durable memory** with **semantic search** and injection using **local embeddings** (`@xenova/transformers`, stored in SQLite). It also includes a **Project Brain** layer: milestones, tasks, decisions, knowledge, and a Unity-oriented **file index** in the same database, plus MCP tools to query and resume work across sessions. When supported by the runtime, **sqlite-vec** (`vec0`) accelerates semantic memory KNN search; otherwise the server falls back to in-process cosine similarity.

**npm:** [infinite-context](https://www.npmjs.com/package/infinite-context) · **source:** [infinite-context-keeper-node](https://github.com/sujkh85/infinite-context-keeper-node)

### Requirements

- Node.js **22.5+** (uses `node:sqlite`)
- **sqlite-vec** (optional, recommended): Node **23.5+** with `DatabaseSync(..., { allowExtension: true })` so the bundled `sqlite-vec` extension loads; on older Node or if loading fails, semantic search still works via **JavaScript cosine** on stored embeddings.
- First embedding run may download models (e.g. `Xenova/all-MiniLM-L6-v2`) into the Hugging Face cache
- Optional: **OpenAI-compatible** API key for compaction

### Install & run

```bash
npm install -g infinite-context
infinite-context
```

Or run without a global install:

```bash
npx -y infinite-context
```

From a git checkout: `npm install && npm run build`, then `node dist/index.js`. CLI aliases: `infinite-context` and `infinite-context-keeper`.

### Configuration (short)

1. Defaults ship in `config/default.yaml` (relative to the package root when installed from npm).
2. Point **`ICK_SETTINGS_YAML`** at your own YAML (**absolute path**) for per-project overrides.
3. Any setting can be overridden with **`ICK_` + SNAKE_UPPER** env vars (e.g. `ICK_OPENAI_API_KEY`).
4. **`default_project_id`** in YAML or **`ICK_DEFAULT_PROJECT_ID`** selects the default `project_id` for Project Brain tools when the tool omits `project_id` (default string: `default`).

### Tools

**Context & memory:** `get_context_usage`, `trigger_compaction`, `save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `search_and_inject_memory`, `list_memories`.

**Project Brain:** `project_get_status`, `project_create_milestone`, `task_break_down`, `task_update`, `unity_scan_project`, `memory_search`, `project_resume` (structured state, Unity file index, and a markdown **`inject_block`** for cold starts).

Tool list responses are de-duplicated by tool name on the server side.

`semantic_search_memory` and `memory_search` responses include **`sqlite_vec_knn`**: `true` when sqlite-vec is loaded and semantic rows use the `vec0` KNN path; `false` when the server uses the JavaScript cosine fallback.

### Long-running agent rules

For multi-session execution on the same project, paste and use the block below in Cursor Rules, `AGENTS.md`, or a system prompt.

```text
You are a long-running agent that actively uses the "Infinite Context" MCP.

The project goal is defined in requirements.md.
The core principle is "do not stop after the first task"; if at least one task remains, you must continue with the next one.

Rules:
1. At the start of every session, you must inspect the current state through Infinite Context.
   - Use **project_resume(project_id?, session_id?)** first to gather Project Brain summary, `inject_block`, recent compaction signals, and top semantic chunks.
   - Use **project_get_status(project_id?)** to check milestones, tasks, and index status.
   - Use list_memories(project_id, session_id) to review recent compaction metadata and summary flow.
   - Use semantic_search_memory, **memory_search**, and inject_relevant_memories to find "in-progress work", "blockers", "next steps", and prior decisions/knowledge.
   - If needed, use search_and_inject_memory(task_description, project_id, session_id) to get an injection block tailored to this session's goal.
   - Use get_context_usage(max_tokens, …) regularly to monitor context usage.

2. Enforce the work loop. (Critical)
   - Always run in this cycle: "select next incomplete task -> execute -> verify -> save memory -> select next task".
   - Never stop while incomplete tasks exist.
   - "report-only then stop" is forbidden; complete real changes/verification/recording, then immediately move to the next task.
   - Stopping is allowed only when all requirements.md goals and tasks are complete.

3. Run forced handoff at 75% context usage. (Critical)
   - If usage ratio from get_context_usage reaches 75% or higher, start handoff immediately.
   - With save_memory, store these fields in structured form: current progress, completed/incomplete tasks, failure causes, next action, restart checklist.
   - Call trigger_compaction(project_id, session_id, conversation_text or messages, with custom_instruction explicitly saying "preserve project goals, requirements core points, and incomplete tasks").
   - Add/sync remaining work in Infinite Context, then continue in a new session (new window) using project_resume.
   - Right after handoff, the new session must read saved next_steps and resume from the next incomplete task immediately.

4. Recording rules during execution:
   - Always follow requirements.md.
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

Now read requirements.md, analyze the full project goal, and do not stop at only the first task; continue executing as far as completion is possible in sequence.
```

### License

MIT (see `package.json`).

**More detail** — Cursor / Claude `mcp.json` samples and the Python vs Node comparison table are in the **한국어** section below.

---

## 한국어

**Infinite Context Keeper**는 Model Context Protocol(MCP) 서버입니다. 대화 컨텍스트 사용량 조회, compaction, 장기 메모 저장·시맨틱 검색·주입을 도구로 제공합니다. compaction 메타와 시맨틱 메모는 **같은 SQLite DB**에 두며, 시맨틱 행은 **`semantic_memories`**와 **로컬 임베딩(@xenova/transformers)** 으로 저장합니다. 여기에 **Project Brain**이 더해져 `projects` / `milestones` / `tasks` / `decisions` / `knowledge` / **`project_files`(Unity 스캔 인덱스)** 등을 한 DB에서 관리하고, 세션 재개용 **`project_resume`** 등 MCP 도구로 읽고 갱신할 수 있습니다. 런타임이 허용하면 **`sqlite-vec`(vec0)** 으로 시맨틱 메모 KNN 검색을 가속하고, 아니면 기존처럼 **JS 코사인**으로 폴백합니다.

npm: [infinite-context](https://www.npmjs.com/package/infinite-context)

### 요구 사항

- Node.js **22.5+** (`node:sqlite` 사용)
- **sqlite-vec**(선택·권장): Node **23.5+**에서 `node:sqlite` 확장 로드가 되면 `sqlite-vec` 패키지가 시맨틱 KNN 인덱스를 사용합니다. 그렇지 않으면 저장된 BLOB 임베딩에 대해 **JS 코사인** 검색으로 동작합니다.
- 첫 임베딩 시 Hugging Face 캐시로 `Xenova/all-MiniLM-L6-v2` 등 모델이 내려받아질 수 있음
- (선택) compaction LLM: **OpenAI 호환 API** 키

### 설치 (npm)

전역 CLI:

```bash
npm install -g infinite-context
```

또는 실행할 때만 내려받기:

```bash
npx -y infinite-context
```

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

**Project Brain 기본 프로젝트:** YAML의 `default_project_id` 또는 환경변수 **`ICK_DEFAULT_PROJECT_ID`**로, 도구 인자에서 `project_id`를 생략했을 때 쓸 ID를 지정합니다(기본값 문자열 `default`).

### 실행 (stdio MCP)

npm 전역 설치 후:

```bash
infinite-context
```

(`infinite-context-keeper` 별칭도 동일 진입점입니다.)

npx만 쓰는 경우:

```bash
npx -y infinite-context
```

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

**컨텍스트·메모리:** `get_context_usage`, `trigger_compaction`, `save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `search_and_inject_memory`, `list_memories`.

**Project Brain:** `project_get_status`, `project_create_milestone`, `task_break_down`, `task_update`, `unity_scan_project`, `memory_search`, `project_resume`.

도구 목록 응답은 서버에서 tool name 기준으로 중복 제거해서 반환합니다.

| 도구 | 요약 |
|------|------|
| `project_get_status` | 프로젝트·마일스톤·태스크·최근 결정/지식·인덱스된 Unity 파일 수 요약 |
| `project_create_milestone` | 마일스톤 추가(`order_num` 자동) |
| `task_break_down` | `tasks` 배열 없으면 분해 안내만 반환; 채워서 재호출 시 태스크 일괄 삽입 |
| `task_update` | 태스크 상태·노트(설명에 타임스탬프)·`actual_hours` 가산 |
| `unity_scan_project` | Unity 루트 스캔 후 `project_files` 갱신(기본 `cwd`) |
| `memory_search` | 시맨틱 메모 + 결정/지식 텍스트 혼합 검색 |
| `project_resume` | 새 세션용 `inject_block`(마크다운)·구조화 데이터·compaction 힌트·시맨틱 상위 청크 |

`semantic_search_memory` / `memory_search` 응답의 **`sqlite_vec_knn`**: 시맨틱 행에 대해 sqlite-vec KNN 경로가 켜졌는지 여부입니다.

### 장기 컨텍스트 유지 (에이전트 지침)

여러 채팅 세션에 걸쳐 같은 프로젝트를 이어갈 때, Cursor **Rules**·**AGENTS.md**·시스템 프롬프트 등에 아래 지침을 붙여 두면 Infinite Context Keeper MCP로 **진행 상황·결정·다음 할 일**을 DB에 남기고, 새 세션에서 다시 주입할 수 있습니다.  
`project_id`·`session_id`는 프로젝트마다 **고정 문자열**으로 쓰는 것을 권장합니다(예: `project_id: "my-app"`, `session_id: "main"`).

아래 블록은 저장소에 실제로 노출된 **도구 이름**과 맞춰 두었습니다.

```text
너는 "Infinite Context" MCP를 적극적으로 사용하는 장기 실행 에이전트다.

프로젝트 목표는 requirements.md 파일에 정의되어 있다.
핵심 원칙은 "첫 작업 후 종료 금지"이며, 남은 작업이 1개라도 있으면 반드시 다음 작업을 계속 수행한다.

규칙:
1. 매 세션 시작 시 반드시 Infinite Context로 현재 상태를 파악한다.
   - **project_resume(project_id?, session_id?)** 로 Project Brain 요약, `inject_block`, 최근 compaction, 시맨틱 상위 청크를 우선 수집한다.
   - **project_get_status(project_id?)** 로 마일스톤·태스크·인덱스 상태를 확인한다.
   - list_memories(project_id, session_id)로 최근 compaction 메타·요약 흐름을 확인한다.
   - semantic_search_memory, **memory_search**, inject_relevant_memories로 "진행 중 작업", "블로커", "다음 단계", 과거 결정/지식을 검색한다.
   - 필요 시 search_and_inject_memory(task_description, project_id, session_id)로 이번 세션 목적에 맞는 주입 블록을 받는다.
   - get_context_usage(max_tokens, …)로 컨텍스트 사용량을 수시 확인한다.

2. 작업 루프를 강제한다. (중요)
   - 항상 "다음 미완료 태스크 선택 -> 실행 -> 검증 -> 메모리 저장 -> 다음 태스크 선택" 순환으로 동작한다.
   - 미완료 태스크가 존재하면 절대 종료하지 않는다.
   - "보고만 하고 종료"는 금지하며, 실제 변경/검증/기록까지 완료한 뒤 즉시 다음 태스크로 넘어간다.
   - 종료는 requirements.md 상의 목표와 태스크가 모두 완료된 경우에만 허용된다.

3. 컨텍스트 75% 도달 시 강제 handoff 절차를 수행한다. (중요)
   - get_context_usage 기준 사용 비율이 75% 이상이면 즉시 handoff 준비를 시작한다.
   - save_memory로 반드시 아래 항목을 구조화해 저장한다: 현재 진행 상태, 완료/미완료 태스크, 실패 원인, 다음 액션, 재시작 체크리스트.
   - trigger_compaction(project_id, session_id, conversation_text 또는 messages, custom_instruction에 "프로젝트 목표와 requirements 핵심, 미완료 태스크를 보존" 명시)을 호출한다.
   - Infinite Context에 남은 일을 추가/동기화한 뒤, 새 세션(새 창)에서 project_resume으로 이어서 작업한다.
   - handoff 직후 새 세션은 저장된 next_steps를 즉시 읽고 다음 미완료 태스크부터 재개한다.

4. 작업 수행 중 기록 규칙:
   - requirements.md를 항상 준수한다.
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

지금 requirements.md를 읽고 전체 목표를 분석한 뒤, 첫 번째 작업만 제시하지 말고 완료 가능한 범위까지 연속적으로 작업을 수행하라.
```

### Python과의 차이 요약

| 항목 | Python | Node |
|------|--------|------|
| 시맨틱 저장 | Chroma + sentence-transformers | SQLite `semantic_memories` + `@xenova/transformers` + (선택) **sqlite-vec** `vec0` KNN |
| MCP 런타임 | FastMCP | `@modelcontextprotocol/sdk` |
| 토큰 추정 | tiktoken | `@dqbd/tiktoken` (지원 인코딩 부분 집합; `o200k_base` 등은 내부적으로 `cl100k_base`로 매핑될 수 있음) |
| 프로젝트 상태 | (구현에 따름) | SQLite: Project Brain 테이블 + `project_files` |

### 라이선스

MIT (`package.json` 기준).
