# Local File Agent 활용 가이드 프롬프트

## 🎯 기본 설정
```
당신은 Local File Agent를 통해 로컬 프로젝트를 분석하고 수정하는 AI 에이전트입니다.
Local File Agent는 http://58.121.142.180:4312에서 실행 중이며, 
모든 요청에 x-agent-token: 73025532 헤더가 필요합니다.

프로젝트 경로: D:/home/8phone (설정된 루트 디렉토리)
```

## 📋 기본 워크플로우 프롬프트

### 1. 프로젝트 분석 시작
```
프로젝트를 분석하기 위해 다음 단계를 수행해주세요:

1. 먼저 /index 엔드포인트로 프로젝트 인덱스를 생성해주세요
2. /index/summary로 인덱스 정보를 확인해주세요  
3. /index/search로 관련 파일들을 검색해주세요
4. 찾은 파일들을 /file로 실제로 읽어보세요
```

### 2. 코드 검색 및 분석
```
다음과 같은 검색 작업을 수행해주세요:

- "component"라는 키워드가 포함된 파일 찾기:
  GET /index/search?pathContains=component&limit=20

- "Button"이라는 컴포넌트가 있는 파일 찾기:
  GET /index/search?exportName=Button

- "import"에 "axios"가 포함된 파일 찾기:
  GET /index/search?importContains=axios
```

### 3. 파일 내용 읽기
```
특정 파일의 내용을 확인하려면:

GET /file?path=src/components/Button.tsx
```

### 4. 코드 검색 (grep)
```
코드에서 특정 텍스트를 검색하려면:

GET /grep?q=useState&glob=src/**/*.{ts,tsx,js,jsx}&limit=50
```

## 🛠️ 파일 수정 프롬프트 템플릿

### 리팩토링 요청 예시
```
"src/components/UserProfile.tsx 파일에서 중복된 validation 로직을 제거하고, 
공통 유틸리티 함수로 분리해주세요."

처리 과정:
1. 해당 파일 읽기 (/file)
2. 중복 코드 패턴 찾기 (/grep)
3. patch 파일 작성 (unified diff 형식)
4. dry run으로 테스트 (/patch-batch, dryRun: true)
5. 실제 적용 (/patch-batch)
```

### 기능 추가 요청 예시
```
"src/pages/Dashboard.tsx에 데이터 로딩 상태를 표시하는 로딩 스피너를 추가해주세요.
로딩 중에는 '데이터를 불러오는 중입니다...' 메시지를 보여주세요."

처리 과정:
1. 기존 파일 분석 (/file)
2. 필요한 의존성 확인 (/grep으로 state 관리 패턴 검색)
3. 새로운 컴포넌트 또는 기존 컴포넌트 수정
4. 패치 적용
```

## 💬 Cline 대화 예시

### 예시 대화 1: 프로젝트 구조 파악
**User**: "내 프로젝트를 분석해줘"

**Cline 응답**:
``` 
로컬 프로젝트를 분석하기 위해 Local File Agent를 사용하겠습니다.

1. 프로젝트 인덱스를 생성하겠습니다:
POST http://localhost:4312/index
Header: x-agent-token: 73025532

2. 인덱스 요약 정보를 확인하겠습니다:
GET http://localhost:4312/index/summary
Header: x-agent-token: 73025532

3. 주요 컴포넌트 파일들을 검색하겠습니다:
GET http://localhost:4312/index/search?pathContains=component&limit=20
Header: x-agent-token: 73025532

분석 결과:
- 프로젝트에는 551개의 TypeScript/React 파일이 있습니다.
- 주요 컴포넌트 파일들을 식별했습니다.
```

### 예시 대화 2: 구체적인 수정 요청
**User**: "Button 컴포넌트에 로딩 상태를 추가해줘"

**Cline 응답**:
``` 
Button 컴포넌트를 찾아서 로딩 상태 기능을 추가하겠습니다.

1. Button 컴포넌트가 있는 파일을 찾겠습니다:
GET http://localhost:4312/index/search?exportName=Button

2. 현재 코드를 분석하겠습니다:
GET http://localhost:4312/file?path=src/components/Button.tsx

3. 새로운 props와 로딩 로직을 추가한 patch를 작성하여 dryRun으로 테스트하겠습니다.
```

## 🔄 실제 요청 예시 (curl)

### 프로젝트 인덱싱
```bash
curl -X POST http://localhost:4312/index -H "x-agent-token: 73025532"
```

### 코드에서 useState 검색
```bash
curl "http://localhost:4312/grep?q=useState&glob=src/**/*.{ts,tsx}&limit=20" -H "x-agent-token: 73025532"
```

### 파일 수정 (dry run)
```bash
curl -X POST http://localhost:4312/patch-batch \
  -H "Content-Type: application/json" \
  -H "x-agent-token: 73025532" \
  -d '{
    "dryRun": true,
    "patches": [
      {
        "path": "src/App.tsx",
        "patch": "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,3 +1,4 @@\n import React from \"react\";\n+import \"./App.css\";\n \n function App() {"
      }
    ]
  }'
```

## 📝 자주 사용되는 작업별 프롬프트

### 코드 품질 개선
```
"프로젝트 전체에서 사용되지 않는 import를 찾아서 정리해주세요."
1. /index로 전체 인덱스 생성
2. 각 파일의 imports와 실제 사용 여부 분석
3. 필요 없는 import 제거 patch 작성
4. 일괄 적용 (/patch-batch)
```

### 타입 안전성 개선
```
"모든 any 타입을 적절한 타입으로 대체해주세요."
1. /grep?q=any로 any 타입 사용箇所 검색
2. 각 파일의 컨텍스트 분석
3. 구체적인 타입 정의
4. 패치 적용
```

## 🎯 Cline에서 효과적인 프롬프트 팁

1. **명확한 작업 지시**: 구체적으로 어떤 파일을 수정하고 싶은지 명시하세요.
2. **단계별 진행**: 복잡한 작업은 여러 단계(분석 -> 전략 수립 -> 수정 -> 검증)로 나누어 요청하세요.
3. **dry run 우선**: 실제 적용 전에 항상 `/patch-batch`에서 `dryRun: true`로 테스트하세요.
4. **검증 요청**: 수정 후 `/file` 또는 `/run`을 통해 결과 확인을 요청하세요.

## ⚠️ 주의사항

1. **항상 dryRun으로 테스트**: 패치 적용 전에 반드시 테스트하세요.
2. **작은 단위로 작업**: 한 번에 너무 많은 파일을 수정하지 마세요.
3. **백업 생성**: 중요 작업 전 현재 상태를 확인하세요.
4. **테스트 실행**: 수정 후 `/run`으로 테스트 실행하여 검증하세요.

## ⚡ 빠른 시작 체크리스트

- [ ] Local File Agent 서버 실행 (`npm run dev`)
- [ ] 프로젝트 경로 확인 (`D:/home/8phone`)
- [ ] 토큰 확인 (`73025532`)
- [ ] 첫 번째 인덱싱 실행 (`POST /index`)
- [ ] Cline과 첫 번째 대화 시작

## 🔗 API 참고

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/index` | POST | 프로젝트 인덱스 생성 |
| `/index/summary` | GET | 인덱스 요약 정보 |
| `/index/search` | GET | 파일 검색 |
| `/file` | GET | 파일 읽기 |
| `/file` | POST | 파일 쓰기 |
| `/patch` | POST | 단일 패치 적용 |
| `/patch-batch` | POST | 배치 패치 적용 |
| `/grep` | GET | 코드 검색 |
| `/run` | POST | 명령 실행 |

**헤더**: `x-agent-token: 73025532`
**콘텐츠 타입**: `application/json` (POST 요청)
