# Infinite Context Keeper (Node.js)

[Python(FastMCP) 버전](../infinite-context-keeper-py/)과 동일한 **MCP 도구 세트**를 Node.js로 구현했습니다. compaction 메타는 **SQLite**에, 시맨틱 메모는 **같은 SQLite DB의 `semantic_memories` 테이블 + 로컬 임베딩(@xenova/transformers)** 에 저장합니다. (Python은 Chroma 영속 디렉터리를 별도로 씁니다. 데이터 디렉터리는 호환되도록 동일한 `data_dir`·파일명을 사용하지만 벡터 DB 포맷은 다릅니다.)

## 요구 사항

- Node.js **22.5+** (`node:sqlite` 사용)
- 첫 임베딩 시 Hugging Face 캐시로 `Xenova/all-MiniLM-L6-v2` 등 모델이 내려받아질 수 있음
- (선택) compaction LLM: **OpenAI 호환 API** 키

## 설치·빌드

```bash
cd infinite-context-keeper-node
npm install
npm run build
```

## 설정

1. 기본값: `config/default.yaml`
2. 사용자 YAML: 환경변수 **`ICK_SETTINGS_YAML`**에 파일 **절대 경로**
3. 예시 키: `config/config.example.yaml`

환경변수 접두사 **`ICK_`** (Python과 동일한 필드명을 스네이크 대문자로 매핑).

## 실행 (stdio MCP)

```bash
node dist/index.js
```

또는 전역 설치 후:

```bash
infinite-context-keeper
```

## Claude Code 등록 예시

```bash
claude mcp add --transport stdio --scope project infinite-context-keeper -- \
  node C:/Users/you/Documents/infinite-context-keeper-node/dist/index.js
```

`.mcp.json` 예시:

```json
{
  "mcpServers": {
    "infinite-context-keeper": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/you/Documents/infinite-context-keeper-node/dist/index.js"],
      "cwd": "C:/Users/you/Documents/infinite-context-keeper-node",
      "env": {
        "ICK_SETTINGS_YAML": "C:/Users/you/Documents/infinite-context-keeper-node/config/config.example.yaml",
        "ICK_OPENAI_API_KEY": "${ICK_OPENAI_API_KEY}"
      }
    }
  }
}
```

## 노출 도구

Python README와 동일: `get_context_usage`, `trigger_compaction`, `save_memory`, `semantic_search_memory`, `inject_relevant_memories`, `search_and_inject_memory`, `list_memories`.

## Python과의 차이 요약

| 항목 | Python | Node |
|------|--------|------|
| 시맨틱 저장 | Chroma + sentence-transformers | SQLite `semantic_memories` + `@xenova/transformers` |
| MCP 런타임 | FastMCP | `@modelcontextprotocol/sdk` |
| 토큰 추정 | tiktoken | `@dqbd/tiktoken` (지원 인코딩 부분 집합; `o200k_base` 등은 내부적으로 `cl100k_base`로 매핑될 수 있음) |

## 라이선스

MIT (`package.json` 기준).
