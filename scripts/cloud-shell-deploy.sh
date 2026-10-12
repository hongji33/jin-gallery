#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "작업이 중단되었습니다. 오류 화면을 알려 주세요. 기존 jin-gallery 데이터는 삭제하지 않습니다." >&2' ERR
SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_ROOT"

if ! command -v gcloud >/dev/null || ! command -v python3 >/dev/null; then
  echo 'Google Cloud Shell에서 실행해 주세요: https://shell.cloud.google.com/?show=terminal&project=jin-gallery-v2' >&2
  exit 1
fi
if ! command -v node >/dev/null; then
  echo 'Cloud Shell에서 Node.js가 필요합니다.' >&2; exit 1
fi
if (( $(node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  exec npx --yes --package=node@22 --package=npm@11 -- bash scripts/cloud-shell-deploy.sh "$@"
fi

# 결제 상태부터 읽습니다. 결제 계정을 연결하거나 변경하지 않습니다.
python3 scripts/cloud-shell-prepare.py --check-only "$@"
echo '테스트 도구와 서버 의존성을 설치합니다.'
npm ci --ignore-scripts
npm ci --prefix functions --ignore-scripts
npm test
python3 -m unittest test/cloud_shell_test.py

# 준비 단계: 새 프로젝트에 필요한 API·App Check·서버 권한과 공개 웹 설정만 적용합니다.
python3 scripts/cloud-shell-prepare.py "$@"

if ! ./node_modules/.bin/firebase projects:list --json > .gallery-projects.json 2>/dev/null || ! python3 - <<'PY'
import json
try:
    data=json.load(open('.gallery-projects.json'))
    assert any(p.get('projectId') == 'jin-gallery-v2' for p in data.get('result', []))
except (OSError, ValueError, TypeError, AssertionError):
    raise SystemExit(1)
PY
then
  echo 'Firebase 배포 권한을 연결합니다. 표시된 링크에서 이 프로젝트를 만든 Google 계정으로 로그인해 주세요.'
  ./node_modules/.bin/firebase login --reauth --no-localhost
fi
rm -f .gallery-projects.json

echo
echo '배포 대상: jin-gallery-v2 (기존 jin-gallery와 별도 프로젝트)'
echo '공개 주소: https://jin-gallery-v2.web.app'
echo '배포 내용: Firestore 보안 규칙, 서울 리전 서버 함수 4개, 새 웹앱'
echo '학생 작품·감상·점수 등 Firestore 데이터 삭제와 이전은 하지 않습니다.'
echo 'Cloud Functions 등은 사용량에 따라 비용이 발생할 수 있습니다.'
read -r -p '이 새 프로젝트에 배포하려면 DEPLOY를 입력하세요. 그 외 입력은 취소: ' GALLERY_APPROVAL
if [[ "$GALLERY_APPROVAL" != 'DEPLOY' ]]; then
  echo '설정 준비까지만 완료했습니다. 웹앱과 서버는 배포하지 않았습니다.'
  exit 0
fi
./node_modules/.bin/firebase deploy --project jin-gallery-v2 --only firestore:rules,functions:secure-gallery,hosting
echo
echo '배포 완료: https://jin-gallery-v2.web.app'
echo '교사 계정으로 로그인하여 활동 추가 → 학생 2명 발급 → 학생 로그인과 작품·퀴즈를 먼저 확인해 주세요.'
echo '로그인이 안 되면 오류 화면을 보내 주세요. 기존 사이트와 데이터는 그대로입니다.'
