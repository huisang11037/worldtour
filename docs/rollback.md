# 배포 백업 · 롤백 방법

Render는 `main` 브랜치에 push되면 자동으로 다시 배포합니다. 그래서 롤백은 "`main`을 백업 시점의 코드로 되돌리는 것"입니다.

## 백업

| 백업 | 커밋 | 내용 |
|---|---|---|
| 브랜치 `backup/2026-11-18` | `fb08dda` | 음성 인식·모바일 화면 반영 **전** Render 배포 버전 (PR #1 병합 직후) |

> 백업 브랜치는 지우거나 push하지 마세요. 새 백업이 필요하면 `backup/날짜` 이름으로 브랜치를 하나 더 만듭니다.
> `git branch backup/2026-12-01 main && git push origin backup/2026-12-01`

## 롤백 방법

### 방법 1. 변경 되돌리기 커밋 (추천)

기록이 남고 force push가 필요 없어 팀원 작업과 충돌하지 않습니다.

**PR로 병합한 경우** (`Merge pull request #...` 커밋이 생긴 경우) — 그 병합 커밋 하나만 되돌립니다.

```bash
git checkout main
git pull
git log --oneline -5                      # "Merge pull request #..." 커밋의 해시 확인
git revert --no-edit -m 1 <병합커밋해시>   # PR 전체를 되돌리는 커밋 생성
git push origin main                      # Render가 자동으로 재배포
```

**PR 없이 main에 바로 올린 경우** — 백업 이후의 커밋을 모두 되돌립니다.

```bash
git checkout main
git pull
git revert --no-edit fb08dda..HEAD
git push origin main
```

위 명령이 충돌 등으로 실패하면 (`git revert --abort`로 취소한 뒤), 파일만 백업 시점으로 되돌려 커밋합니다.

```bash
git checkout main
git pull
git checkout backup/2026-11-18 -- .       # 작업 폴더의 파일을 백업 시점으로
git commit -m "롤백: backup/2026-11-18 시점으로 되돌림"
git push origin main
```

> 두 번째 방법은 백업 이후 **새로 추가된 파일**은 지우지 않습니다. 남은 파일이 있으면 `git rm`으로 지운 뒤 커밋하세요.

### 방법 2. GitHub에서 PR 되돌리기

변경을 Pull Request로 병합했다면, GitHub의 해당 PR 화면 아래 **Revert** 버튼을 누르면 되돌리는 PR이 만들어집니다. 그 PR을 병합하면 재배포됩니다.

### 방법 3. Render에서 이전 배포로 즉시 복구 (임시)

Render 대시보드 → 서비스 → **Events** → 이전 배포의 **Rollback** 을 누르면 코드 변경 없이 바로 이전 버전으로 돌아갑니다.
단, `main`은 그대로이므로 다음 push 때 다시 새 버전이 배포됩니다. 급할 때 먼저 이 방법으로 복구하고, 방법 1로 `main`을 정리하세요.

## 데이터 주의

무료 플랜은 디스크가 없어 재배포할 때마다 DB가 예시 데이터로 초기화됩니다. 롤백해도 그 사이 들어온 회원·예약 데이터는 남지 않습니다.
