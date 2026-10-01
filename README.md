# EFT Where Am I KO

[karpitony/eft-where-am-i](https://github.com/karpitony/eft-where-am-i)를 바탕으로 만든 한국어 버전입니다.
tarkov-market.com 대신 [tarkov.dev](https://tarkov.dev) 데이터를 사용하며, 이 데이터는 [the-hideout/tarkov-data-manager](https://github.com/the-hideout/tarkov-data-manager)가 만들어 `json.tarkov.dev`로 배포합니다.
맵별로 퀘스트를 여러 개 등록해서 볼 수 있는 기능을 새로 넣었습니다.

## 실행

### 웹 버전 (설치 없이 브라우저에서)
**https://ky001144-max.github.io/tarkov_quest_claude/**

- GitHub Pages로 배포됩니다. tarkov.dev·위키 데이터는 GitHub Actions가 6시간마다 새로 가공해서 올립니다.
- 등록한 퀘스트와 설정은 브라우저(localStorage)에 저장됩니다. 다른 브라우저나 PC와는 공유되지 않습니다.
- **Chrome·Edge**: ⚙ 설정에서 스크린샷 폴더(`문서\Escape from Tarkov\Screenshots`)와 게임 로그 폴더(`Logs`)를 연결하면 데스크톱 버전처럼 스크린샷 자동 위치 표시와 자동 맵 전환이 됩니다. 브라우저를 새로 열면 **내 위치 확인**을 한 번 눌러 폴더 접근을 다시 허용해야 합니다.
- **그 밖의 브라우저**: 폴더 연결을 지원하지 않아서, **내 위치 확인**을 누르면 스크린샷 파일을 직접 골라 위치를 표시합니다.
- 웹 버전에는 스크린샷 자동 삭제, 경로 자동 탐지, GPU 가속 설정이 없습니다.

### 데스크톱 버전 (Windows)
`dist/EFT-Where-Am-I-KO-1.0.0.exe`를 실행하면 됩니다. 설치 없이 바로 실행되는 portable 버전입니다.
Windows 10/11 x64에서 동작하고, 처음 실행할 때 데이터를 받기 위해 인터넷 연결이 필요합니다.

## 기능

### 맵별 퀘스트 여러 개 등록
- **＋ 퀘스트 등록**을 누르면 지금 선택한 맵의 퀘스트가 상인별로 나옵니다. 원하는 퀘스트를 **여러 개 체크**한 뒤 **등록**을 누르세요.
  - 이름이나 목표 내용으로 검색할 수 있고, 상인·카파 필요 여부로 거를 수 있습니다. 맵과 상관없는 퀘스트도 목록에 넣을 수 있습니다.
  - 지금 보이는 항목을 한 번에 선택하거나 선택 해제할 수 있습니다.
- 등록한 퀘스트는 **왼쪽 목록**에 이렇게 표시됩니다.
  - 번호와 색상, **퀘스트 제목**, 상인, 필요 레벨, 카파/등대지기 표시, 진행도
  - **퀘스트 목표 전체**: 목표 설명, 필요 수량, 선택 목표 여부, 퀘스트 아이템, 다른 맵에서 하는 목표인지 여부
  - 목표를 체크하면 완료로 표시되고, 📍를 누르면 지도에서 그 위치로 이동합니다(해당 층으로 자동 전환). 위치가 여러 곳이면 누를 때마다 다음 위치로 넘어갑니다.
  - 제목을 클릭하면 접히거나 펼쳐집니다. ▲로 순서를 바꾸고, 🔗로 tarkov.dev 상세 페이지를 열고, ✕로 등록을 해제합니다.
- 지도에는 등록한 퀘스트의 목표 구역(색이 칠해진 영역과 번호 마커)과 퀘스트 아이템 위치가 표시됩니다.
- 등록 목록은 맵마다 따로 저장되어서, 다른 맵에 갔다가 돌아와도 그대로 남아 있습니다.

### 이벤트 퀘스트 (타르코프 위키 기준)
- 이벤트 기간에만 받을 수 있는 퀘스트(위키 [Event content](https://escapefromtarkov.fandom.com/wiki/Category:Event_content) 분류)는 일반 퀘스트와 따로 관리합니다. 아레나 퀘스트는 제외합니다.
- 위키 [Events](https://escapefromtarkov.fandom.com/wiki/Events) 문서의 어느 이벤트에도 들어 있지 않은 문서(테스트용 퀘스트 등)는 빼고, Events 문서에서 "지난 이벤트" 구분선 위에 있는 이벤트의 퀘스트만 진행 중으로 봅니다.
- **＋ 퀘스트 등록** 창의 **이벤트 퀘스트** 탭에서 이벤트별로 묶어서 보여줍니다. 기본으로는 진행 중인 이벤트만 나오고, **종료된 이벤트 포함**을 켜면 지난 이벤트 퀘스트도 볼 수 있습니다. 이벤트를 하나만 골라 볼 수도 있습니다.
- 등록한 이벤트 퀘스트에는 🎉 이벤트(종료된 이벤트는 점선 🎉 종료 이벤트) 배지가 붙습니다.
- 목록은 하루에 한 번 위키에서 새로 받습니다. 번역은 `assets/event_ko.json`에 있고, 번역이 없는 새 퀘스트는 영문으로 나옵니다. 위키에는 좌표가 없어서, 아이템 숨기기·설치·정찰처럼 정해진 장소가 있는 목표는 `assets/event_locations.json`에 위키 가이드 지도를 보고 옮긴 **대략 위치**를 넣어 두었습니다(지도에 번호 마커로 나오고 📍로 이동 가능). 여기에 없는 이벤트 퀘스트는 지도 표시가 되지 않습니다(tarkov.dev에도 있는 퀘스트는 tarkov.dev 좌표를 씁니다).

### 원본에서 가져온 기능
- **내 위치 확인**: 게임에서 스크린샷(PrtSc)을 찍으면 파일 이름에 담긴 좌표를 읽어서 현재 위치와 바라보는 방향을 지도에 표시합니다. **자동**에 체크해 두면 스크린샷을 찍을 때마다 바로 표시됩니다.
- **자동 층 전환**: 캐릭터 높이를 보고 해당 층(2층, 지하 등)으로 바꿔 줍니다.
- **자동 패닝**: 위치 마커가 데드존을 벗어나면 지도가 따라 움직입니다. 데드존은 50~99% 사이에서 조절할 수 있습니다.
- **자동 맵 전환**: 게임 로그를 보고 레이드가 시작되면 그 맵으로 바꿉니다.
- **스크린샷 자동 삭제**: 레이드가 끝나면 스크린샷 폴더를 정리합니다(기본값은 꺼짐).
- 층 선택, 지도 스타일(위키/도면/위성) 전환, 탈출구·이동 지점 표시, PvP/PvE 데이터 전환도 할 수 있습니다.

### 위키 지도 (기본 지도)
- 13개 맵 모두 [타르코프 위키 인터랙티브 지도](https://escapefromtarkov.fandom.com/wiki/Special:AllMaps)의 그림을 기본 지도로 씁니다. 위키 페이지처럼 똑바로 세운 그림 위에 탈출구·퀘스트 위치·내 위치를 표시합니다.
- 위키 그림을 게임 좌표에 맞추는 변환은 위키 마커와 tarkov.dev 좌표(탈출구·스위치 이름, 상자·스폰·잠긴 문 수백 개)를 짝지어 구합니다. 맵마다 오차는 대략 1~4m입니다(인터체인지 바깥 지도는 5~9m).
- 공장·연구소·쇄빙선·인터체인지처럼 층을 나눠 그린 위키 지도는 기본 층 그림을 보여 주고, 오른쪽 층 버튼을 누르면 그 층 그림을 같은 자리에 겹쳐 보여 줍니다. 탈출구 층 표시와 스크린샷 자동 층 전환도 위키 그림 기준입니다.
- 위키 이미지는 크기가 커서, 맵을 처음 열 때 한 번 타일로 잘라 저장합니다. 작은 배율부터 만들어 1초 안에 지도를 보여 주고, 고해상도 타일은 뒤에서 이어 만듭니다(지도 아래 "고해상도 지도 준비 중" 표시). 다음부터는 바로 열립니다.
- 위키 그림은 각 지도 제작자(re3mr, Jindouz, Muhawi 등)의 것이며 위키의 라이선스를 따릅니다.

### 탈출구 (타르코프 위키 기준)
- 탈출구·이동 지점 목록은 [타르코프 위키](https://escapefromtarkov.fandom.com/wiki/Escape_from_Tarkov_Wiki) 맵 문서의 표를 기준으로 합니다. 위키에서 사라진 탈출구는 표시하지 않고, 새로 생긴 탈출구는 추가합니다.
- 위치는 위키 지도 마커 위치를 씁니다. 위키에 마커가 없거나, 지도 옆에 따로 그린 건물·지하 확대도 위에 있는 마커(실제 위치와 60m 넘게 다른 것)는 tarkov.dev 좌표를 씁니다. 둘 다 없으면 지도 왼쪽 아래 **위치 미표시 탈출구** 목록에 나옵니다.
- 지도 오른쪽 **탈출구** 패널에서 PMC / 스캐브 / 트랜짓·Co-op 을 따로 켜고 끌 수 있습니다. PMC·스캐브 공용 탈출구(Co-op 제외)는 PMC나 스캐브 중 하나라도 켜면 보입니다.
- 탈출구를 클릭하면 진영, 항상 열림 여부, 1회용 여부, 조건(요금·필요 아이템 등), 메모가 나옵니다.

> 원본의 Ctrl+NumPad 층 이동 단축키는 넣지 않았습니다. 대신 높이를 보고 층을 자동으로 바꿉니다.

## 설정 / 저장 위치
- 설정과 등록한 퀘스트: `%APPDATA%\EFT Where Am I KO\settings.json`
- 데이터 캐시: `%APPDATA%\EFT Where Am I KO\cache` (tarkov.dev·위키 데이터를 6시간마다 새로 받고, 오프라인일 때는 캐시를 사용). 위키 지도 이미지 원본도 여기에 두고, 잘라 둔 타일은 앱의 IndexedDB에 저장합니다.
- 스크린샷 폴더(`문서\Escape from Tarkov\Screenshots`)와 로그 폴더는 자동으로 찾습니다. 못 찾으면 ⚙ 설정에서 직접 지정하세요.
- 게임 **스크린샷 형식은 PNG**여야 합니다.
- **GPU 가속**은 기본으로 꺼져 있습니다(메모리를 덜 쓰고 게임과 GPU를 나눠 쓰지 않음). 지도 이동이 버벅이면 ⚙ 설정 → 성능에서 켜고 다시 실행하세요.

## 개발

```bash
npm install
npm start          # 개발 실행 (VS Code 터미널이라면 ELECTRON_RUN_AS_NODE 환경변수를 먼저 지우세요)
npm run dist       # dist/ 에 portable exe 생성
node scripts/build-web.js   # _site/ 에 웹 버전 생성 (데이터 가공 포함, GitHub Actions 와 같은 과정)
```

웹 버전 배포: `main`에 push하면 `.github/workflows/pages.yml`이 웹 버전을 만들어 GitHub Pages에 올립니다(6시간마다 데이터만 새로 만들어 다시 배포). 처음 한 번은 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿔야 합니다.

| 파일 | 역할 |
|---|---|
| `main.js` | Electron 메인 프로세스(창, 설정, IPC) |
| `src/data.js` | json.tarkov.dev 데이터를 받아 한국어로 가공하고 캐시 |
| `src/watchers.js` | 스크린샷·게임 로그 감시, 경로 자동 탐지 |
| `renderer/game-files.js` | 스크린샷 파일 이름·게임 로그 줄 해석 (데스크톱·웹 공용) |
| `web/web-api.js` | 웹 버전용 `window.api` (설정 localStorage, 폴더 연결은 File System Access API) |
| `scripts/build-web.js` | 웹 버전(`_site/`) 생성: 화면 코드 복사 + 데이터 가공 + 위키 지도 이미지 받기(위키 이미지 서버가 다른 사이트에서 바로 불러오는 것을 막아서 사이트에 함께 넣음) |
| `.github/workflows/pages.yml` | 웹 버전을 GitHub Pages로 배포 (push 때, 6시간마다) |
| `renderer/map.js` | Leaflet 지도(tarkov.dev 좌표계와 층 처리 방식을 가져옴), 위키 지도 좌표계·층 그림 겹치기 |
| `renderer/wiki-tiles.js` | 위키 지도 타일 저장(IndexedDB)·그리기 레이어 |
| `renderer/wiki-tiler.js` | 위키 지도 이미지를 배율별 타일로 자르는 Web Worker |
| `renderer/app.js` | 퀘스트 등록/목록 UI, 설정, 위치 연동 |
| `src/wiki-extracts.js` | 위키 맵 문서·인터랙티브 지도에서 탈출구 목록을 읽어 tarkov.dev 탈출구와 합침, 위키 지도 → 게임 좌표 변환(맵별 판 구성 `WIKI_LAYOUTS`) |
| `assets/wiki_extracts.json` | 위키 탈출구 목록 오프라인용 사본 (위키를 받지 못할 때 사용) |
| `src/wiki-events.js` | 위키 Event content 분류에서 이벤트 퀘스트와 이벤트 이름·기간을 읽음 |
| `assets/event_tasks.json` | 이벤트 퀘스트 오프라인용 사본 (위키를 받지 못할 때 사용) |
| `assets/event_locations.json` | 이벤트 퀘스트 목표의 대략 위치 (위키 가이드 지도 기준, 퀘스트 영문 이름 + 목표 문장 일부로 연결) |
| `assets/event_ko.json` | 이벤트 이름·퀘스트 이름·목표의 한국어 번역 |
| `assets/maps.json` | tarkov.dev 맵 설정 오프라인용 사본 |
| `assets/ko_overrides.json` | tarkov.dev 한국어 데이터에 없는 퀘스트 이름·목표·아이템의 보완 번역 (영문 → 한국어) |
| `assets/extra_tasks.json` | tarkov.dev에 아직 없는 최신 퀘스트(타르코프 위키 기준). tarkov.dev에 같은 영문 이름의 퀘스트가 생기면 자동으로 무시됨. 지도 위치 정보는 없음 |

## 크레딧
- 원본: [karpitony/eft-where-am-i](https://github.com/karpitony/eft-where-am-i) (MIT). 아이콘도 원본 것을 사용했습니다.
- 데이터, 지도 타일/SVG: [tarkov.dev](https://tarkov.dev) / [the-hideout](https://github.com/the-hideout)
- 위키 지도·탈출구·이벤트 정보: [Escape from Tarkov Wiki](https://escapefromtarkov.fandom.com) (지도 그림: re3mr, Jindouz, Muhawi 등)
- 이 프로그램을 써서 생기는 어떤 불이익(BSG 제재 등)도 책임지지 않습니다.
