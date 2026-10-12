"""jin-gallery-v2 전용 준비. 키 파일 없이 Cloud Shell의 gcloud 인증만 사용합니다."""
import argparse
import json
import re
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

PROJECT = 'jin-gallery-v2'
SERVICES = [
    'firebase.googleapis.com', 'firestore.googleapis.com', 'identitytoolkit.googleapis.com',
    'firebaseappcheck.googleapis.com', 'recaptchaenterprise.googleapis.com',
    'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com',
    'run.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'firebasehosting.googleapis.com',
    'logging.googleapis.com',
    'compute.googleapis.com',
]

class ApiError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status

def gcloud(*args):
    # 토큰은 메모리에서만 다루며 로그나 파일에 출력하지 않습니다.
    result = subprocess.run(['gcloud', *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('gcloud 설정/권한 오류: ' + result.stderr.strip())
    return result.stdout.strip()

def api(method, url, body=None):
    allowed = ('https://firebase.googleapis.com/', 'https://firestore.googleapis.com/',
               'https://identitytoolkit.googleapis.com/', 'https://recaptchaenterprise.googleapis.com/',
               'https://firebaseappcheck.googleapis.com/', 'https://iam.googleapis.com/',
               'https://firebasehosting.googleapis.com/', 'https://cloudbuild.googleapis.com/')
    if not url.startswith(allowed):
        raise RuntimeError('허용하지 않은 API 주소입니다.')
    token = gcloud('auth', 'print-access-token')
    data = None if body is None else json.dumps(body).encode()
    for attempt in range(4):
        request = Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
            'X-Goog-User-Project': PROJECT,
        })
        try:
            with urlopen(request, timeout=60) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except HTTPError as error:
            try:
                info = json.loads(error.read()).get('error', {})
                message = info.get('message', 'API 요청 실패')
                pending = any(d.get('reason') == 'SERVICE_DISABLED' for d in info.get('details', []))
            except (ValueError, AttributeError):
                message, pending = 'API 요청 실패', False
            if method in ('GET', 'PATCH') and attempt < 3 and (error.code in (429, 500, 503) or pending):
                time.sleep(2 ** (attempt + 1)); continue
            raise ApiError(error.code, f'{error.code}: {message}') from None

def optional_get(url):
    try:
        return api('GET', url)
    except ApiError as error:
        if error.status == 404:
            return None
        raise

def validate_identity(project_info, app_id, teacher_uid):
    if project_info.get('projectId') != PROJECT or project_info.get('lifecycleState') != 'ACTIVE':
        raise RuntimeError('jin-gallery-v2 활성 프로젝트만 준비할 수 있습니다.')
    number = str(project_info['projectNumber'])
    if not re.fullmatch(rf'1:{re.escape(number)}:web:[A-Za-z0-9_-]+', app_id):
        raise RuntimeError('웹 앱 ID가 jin-gallery-v2 프로젝트와 일치하지 않습니다.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', teacher_uid or ''):
        raise RuntimeError('교사 UID를 확인해 주세요.')
    return number

def find_key(keys, app_id):
    # 동일 앱용으로 이 스크립트가 만든 도메인 제한 키만 재사용합니다.
    expected = {PROJECT + '.web.app', PROJECT + '.firebaseapp.com'}
    for key in keys:
        settings = key.get('webSettings', {})
        if (key.get('displayName') == 'jin-gallery-v2 App Check ' + app_id
                and settings.get('integrationType') == 'SCORE'
                and not settings.get('allowAllDomains', False)
                and set(settings.get('allowedDomains', [])) == expected
                and not key.get('testingOptions')):
            return key
    return None

def make_config(firebase, site_key):
    if firebase.get('projectId') != PROJECT or firebase.get('authDomain') != PROJECT + '.firebaseapp.com':
        raise RuntimeError('Firebase 웹 설정이 대상 프로젝트와 일치하지 않습니다.')
    return {'emulator': False, 'schoolYear': '2026', 'firebase': firebase,
            'region': 'asia-northeast3', 'appCheckProvider': 'recaptcha-enterprise', 'appCheckSiteKey': site_key}

def check(args):
    project = json.loads(gcloud('projects', 'describe', PROJECT, '--format=json'))
    number = validate_identity(project, args.app_id, args.teacher_uid)
    billing = json.loads(gcloud('billing', 'projects', 'describe', PROJECT, '--format=json'))
    if billing.get('billingEnabled') is not True:
        raise RuntimeError('결제 계정(Blaze)이 연결되어 있지 않습니다.\n'
                           'https://console.firebase.google.com/project/jin-gallery-v2/usage/details 에서\n'
                           '요금제를 확인하고 연결한 뒤 같은 명령을 다시 실행해 주세요. 결제는 자동 연결하지 않습니다.')
    print('대상 프로젝트와 결제 연결 확인 완료: jin-gallery-v2')
    return number

def prepare(args, number):
    print('필요한 API를 활성화합니다. 처음에는 몇 분 걸릴 수 있습니다.')
    gcloud('services', 'enable', *SERVICES, '--project', PROJECT, '--quiet')
    database = api('GET', f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)')
    if database.get('type') != 'FIRESTORE_NATIVE':
        raise RuntimeError('기본 Firestore 데이터베이스를 확인해 주세요.')
    print('Firestore 위치:', database.get('locationId'))
    users = api('POST', f'https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:lookup',
                {'localId': [args.teacher_uid]}).get('users', [])
    if len(users) != 1 or users[0].get('localId') != args.teacher_uid or users[0].get('disabled'):
        raise RuntimeError('해당 UID의 활성 교사 계정을 찾을 수 없습니다.')
    if not users[0].get('email'):
        raise RuntimeError('교사 계정에 이메일이 없습니다.')
    doc_url = (f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/'
               'v2Accounts/' + quote(args.teacher_uid, safe=''))
    existing = optional_get(doc_url)
    if existing and existing.get('fields', {}).get('role', {}).get('stringValue') not in (None, 'teacher'):
        raise RuntimeError('기존 계정 역할이 교사와 다릅니다. 덮어쓰지 않습니다.')
    fields = {'role': {'stringValue': 'teacher'}, 'active': {'booleanValue': True},
              'classIds': {'arrayValue': {'values': [{'stringValue': f'2026-3-{i}'} for i in range(1, 11)]}}}
    mask = urlencode([('updateMask.fieldPaths', name) for name in fields])
    api('PATCH', doc_url + '?' + mask, {'fields': fields})
    print('교사 담당 반 확인·연결 완료: 3학년 1~10반')

    key_url = f'https://recaptchaenterprise.googleapis.com/v1/projects/{PROJECT}/keys'
    keys, page_token = [], None
    while True:
        suffix = '?' + urlencode({'pageSize': 100, **({'pageToken': page_token} if page_token else {})})
        page = api('GET', key_url + suffix)
        keys.extend(page.get('keys', [])); page_token = page.get('nextPageToken')
        if not page_token:
            break
    key = find_key(keys, args.app_id)
    if key is None:
        key = api('POST', key_url, {
            'displayName': 'jin-gallery-v2 App Check ' + args.app_id,
            'webSettings': {'allowedDomains': [PROJECT + '.web.app', PROJECT + '.firebaseapp.com'],
                            'allowAllDomains': False, 'integrationType': 'SCORE'},
        })
    if not key.get('name', '').startswith(f'projects/{PROJECT}/keys/'):
        # API는 프로젝트 번호로 정규화하여 반환할 수도 있습니다.
        if not key.get('name', '').startswith(f'projects/{number}/keys/'):
            raise RuntimeError('사이트 키의 프로젝트가 일치하지 않습니다.')
    site_key = key['name'].split('/')[-1]
    app_check_name = f'projects/{number}/apps/{args.app_id}/recaptchaEnterpriseConfig'
    api('PATCH', 'https://firebaseappcheck.googleapis.com/v1/' + app_check_name + '?updateMask=siteKey,tokenTtl',
        {'name': app_check_name, 'siteKey': site_key, 'tokenTtl': '3600s'})
    print('Enterprise 사이트 키 생성·App Check 등록 완료 (토큰 수명 1시간)')

    account = f'gallery-runtime@{PROJECT}.iam.gserviceaccount.com'
    sa_url = f'https://iam.googleapis.com/v1/projects/{PROJECT}/serviceAccounts/{account}'
    if optional_get(sa_url) is None:
        api('POST', f'https://iam.googleapis.com/v1/projects/{PROJECT}/serviceAccounts',
            {'accountId': 'gallery-runtime', 'serviceAccount': {'displayName': 'Gallery runtime'}})
    gcloud('projects', 'add-iam-policy-binding', PROJECT, '--member', 'serviceAccount:' + account,
           '--role', 'roles/datastore.user', '--condition=None', '--quiet')
    gcloud('iam', 'service-accounts', 'add-iam-policy-binding', account, '--project', PROJECT,
           '--member', 'serviceAccount:' + account, '--role', 'roles/iam.serviceAccountTokenCreator', '--quiet')
    print('전용 서버 계정 권한 연결 완료 (DB 접근·본인 토큰 서명)')
    build_account = api('GET', f'https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/asia-northeast3/defaultServiceAccount').get('serviceAccountEmail', '').split('/')[-1]
    if build_account not in (f'{number}@cloudbuild.gserviceaccount.com', f'{number}-compute@developer.gserviceaccount.com'):
        raise RuntimeError('프로젝트 기본 빌드 계정을 확인할 수 없습니다. 다른 계정 권한은 변경하지 않습니다.')
    gcloud('projects', 'add-iam-policy-binding', PROJECT, '--member', 'serviceAccount:' + build_account,
           '--role', 'roles/cloudbuild.builds.builder', '--condition=None', '--quiet')
    print('새 프로젝트의 기본 빌드 계정 권한 확인·연결 완료')

    site_url = f'https://firebasehosting.googleapis.com/v1beta1/projects/{PROJECT}/sites/{PROJECT}'
    if optional_get(site_url) is None:
        api('POST', f'https://firebasehosting.googleapis.com/v1beta1/projects/{PROJECT}/sites?siteId={PROJECT}', {})
    firebase = api('GET', f'https://firebase.googleapis.com/v1beta1/projects/{PROJECT}/webApps/{args.app_id}/config')
    config = make_config(firebase, site_key)
    root = Path(__file__).resolve().parents[1]
    (root / 'public/config.js').write_text('window.GALLERY_CONFIG = Object.freeze(' + json.dumps(config, ensure_ascii=False, indent=2) + ');\n')
    (root / f'functions/.env.{PROJECT}').write_text('GALLERY_RUNTIME_SERVICE_ACCOUNT=' + account + '\n')
    hosting = json.loads((root / 'firebase.json').read_text())
    hosting['hosting']['site'] = PROJECT
    (root / 'firebase.json').write_text(json.dumps(hosting, indent=2) + '\n')
    print('공개 웹 설정 생성 완료. 서비스 계정 비밀키는 생성하거나 저장하지 않았습니다.')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--teacher-uid', required=True)
    parser.add_argument('--app-id', required=True)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    number = check(args)
    if not args.check_only:
        prepare(args, number)

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError) as error:
        print('중단: ' + str(error), file=sys.stderr)
        sys.exit(1)
