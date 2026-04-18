# Infinite Context Keeper (Node.js)

## English

**Infinite Context Keeper** is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It exposes tools for **context usage estimation** (tiktoken-style counting), **conversation compaction** (metadata in **SQLite**), and **durable memory** with **semantic search** and injection using **local embeddings** (`@xenova/transformers`, stored alongside compaction data in SQLite).

**npm:** [infinite-context](https://www.npmjs.com/package/infinite-context) · **source:** [infinite-context-keeper-node](https://github.com/sujkh85/infinite-context-keeper-node)

### Requirements

- Node.js **22.5+** (uses `node:sqlite`)
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

### Tools

`get_context_usage`, `trigger_compaction`, `save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `search_and_inject_memory`, `list_memories`.

### License

MIT (see `package.json`).

**More detail** — Cursor / Claude `mcp.json` samples, long-running agent copy-paste rules, and the Python vs Node comparison table are in the **한국어** section below.

---

## 한국어

**Infinite Context Keeper**는 Model Context Protocol(MCP) 서버입니다. 대화 컨텍스트 사용량 조회, compaction, 장기 메모 저장·시맨틱 검색·주입을 도구로 제공합니다. compaction 메타는 **SQLite**에 두고, 시맨틱 메모는 **같은 DB의 `semantic_memories` 테이블**과 **로컬 임베딩(@xenova/transformers)** 으로 저장합니다.

npm: [infinite-context](https://www.npmjs.com/package/infinite-context)

### 요구 사항

- Node.js **22.5+** (`node:sqlite` 사용)
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

`get_context_usage`, `trigger_compaction`, `save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `search_and_inject_memory`, `list_memories`.

### 장기 컨텍스트 유지 (에이전트 지침)

여러 채팅 세션에 걸쳐 같은 프로젝트를 이어갈 때, Cursor **Rules**·**AGENTS.md**·시스템 프롬프트 등에 아래 지침을 붙여 두면 Infinite Context Keeper MCP로 **진행 상황·결정·다음 할 일**을 DB에 남기고, 새 세션에서 다시 주입할 수 있습니다.  
`project_id`·`session_id`는 프로젝트마다 **고정 문자열**으로 쓰는 것을 권장합니다(예: `project_id: "my-app"`, `session_id: "main"`).

아래 블록은 저장소에 실제로 노출된 **도구 이름**과 맞춰 두었습니다.

```text
너는 "Infinite Context Keeper" MCP를 적극적으로 쓰는 장기 프로젝트 에이전트다.

프로젝트 목표는 requirements.md 파일에 정의되어 있다.
목표를 달성할 때까지 여러 세션에 걸쳐 지속적으로 작업해야 한다.

규칙:
1. 매 세션 시작 시 반드시 Keeper로 현재 상태를 파악한다.
   - list_memories(project_id, session_id)로 최근 compaction 메타·요약 흐름을 확인한다.
   - semantic_search_memory 또는 inject_relevant_memories로 "진행 중 작업", "블로커", "다음 단계" 등을 검색해 맥락을 복구한다.
   - 필요하면 search_and_inject_memory(task_description, project_id, session_id)로 이번 세션 목적에 맞는 주입 블록을 받는다.
   - get_context_usage(max_tokens, …)로 남은 컨텍스트 윈도우를 확인한다.
2. 작업할 때는 항상 requirements.md를 준수하고, 중요한 결정·진행 상황은 save_memory(key, content, project_id, session_id, metadata 선택)로 저장한다. 태스크 상태를 바꿀 때도 동일하게 upsert한다.
3. 컨텍스트 사용 비율이 설정의 summarization_start_ratio(기본 약 75%) 이상이면 trigger_compaction(project_id, session_id, conversation_text 또는 messages, custom_instruction에 "프로젝트 목표·requirements 핵심을 잃지 말 것" 등)를 호출해 정리한다. 임계값은 get_context_usage 결과와 설정 YAML을 기준으로 판단한다.
4. 세션이 끝날 때는 save_memory로 next_steps를 명확히 남겨, 다음 세션에서 semantic_search_memory / search_and_inject_memory로 바로 이어질 수 있게 한다.
5. 이전 세션에서 이미 정리된 내용은 길게 반복하지 말고, Keeper에 저장된 요약·메모를 전제로 짧게 이어서 진행한다.

지금 requirements.md를 읽고, 전체 목표를 분석한 후 첫 번째 작업 계획을 세워줘.
```

### Python과의 차이 요약

| 항목 | Python | Node |
|------|--------|------|
| 시맨틱 저장 | Chroma + sentence-transformers | SQLite `semantic_memories` + `@xenova/transformers` |
| MCP 런타임 | FastMCP | `@modelcontextprotocol/sdk` |
| 토큰 추정 | tiktoken | `@dqbd/tiktoken` (지원 인코딩 부분 집합; `o200k_base` 등은 내부적으로 `cl100k_base`로 매핑될 수 있음) |

### 라이선스

MIT (`package.json` 기준).
