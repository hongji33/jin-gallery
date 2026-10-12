import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare', Path('scripts/cloud-shell-prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
PROJECT = 'jin-gallery-v2'
APP = '1:123456:web:abcd'
ARGS = SimpleNamespace(app_id=APP, teacher_uid='test-teacher', check_only=False)

class PreparationTests(unittest.TestCase):
    def test_project_and_app_must_match(self):
        self.assertEqual(prepare.validate_identity({'projectId': PROJECT, 'lifecycleState': 'ACTIVE', 'projectNumber': '123456'}, APP, 'teacher'), '123456')
        for project, app, uid in [('jin-gallery', APP, 'teacher'), (PROJECT, '1:999:web:abcd', 'teacher'), (PROJECT, APP, '../teacher')]:
            with self.assertRaises(RuntimeError):
                prepare.validate_identity({'projectId': project, 'lifecycleState': 'ACTIVE', 'projectNumber': '123456'}, app, uid)

    def test_no_billing_stops_before_mutations(self):
        calls = []
        def cloud(*args):
            calls.append(args)
            return json.dumps({'projectId': PROJECT, 'projectNumber': '123456', 'lifecycleState': 'ACTIVE'} if args[0] == 'projects' else {'billingEnabled': False})
        with patch.object(prepare, 'gcloud', cloud), patch.object(prepare, 'api') as api:
            with self.assertRaisesRegex(RuntimeError, 'Blaze'):
                prepare.check(ARGS)
            api.assert_not_called()
        self.assertTrue(all('enable' not in c and 'add-iam-policy-binding' not in c for c in calls))

    def test_only_matching_restricted_score_key_is_reused(self):
        key = {'name': 'projects/jin-gallery-v2/keys/key', 'displayName': 'jin-gallery-v2 App Check ' + APP,
               'webSettings': {'integrationType': 'SCORE', 'allowedDomains': [PROJECT + '.web.app', PROJECT + '.firebaseapp.com'], 'allowAllDomains': False}}
        self.assertEqual(prepare.find_key([key], APP), key)
        for change in [{'allowAllDomains': True}, {'integrationType': 'CHECKBOX'}, {'allowedDomains': ['example.com']}]:
            changed = {**key, 'webSettings': {**key['webSettings'], **change}}
            self.assertIsNone(prepare.find_key([changed], APP))
        self.assertIsNone(prepare.find_key([{**key, 'testingOptions': {'testingScore': 1}}], APP))

    def test_wrong_web_config_is_rejected(self):
        with self.assertRaises(RuntimeError):
            prepare.make_config({'projectId': 'jin-gallery', 'authDomain': 'jin-gallery.firebaseapp.com'}, 'key')

    def test_preparation_never_deploys_or_deletes_and_does_not_overwrite_other_fields(self):
        requests, commands = [], []
        firebase = {'projectId': PROJECT, 'authDomain': PROJECT + '.firebaseapp.com', 'appId': APP, 'apiKey': 'public-test-key'}
        def api(method, url, body=None):
            requests.append((method, url, body))
            if '/databases/(default)' in url and '/documents/' not in url:
                return {'type': 'FIRESTORE_NATIVE', 'locationId': 'asia-northeast3'}
            if 'accounts:lookup' in url:
                return {'users': [{'localId': ARGS.teacher_uid, 'email': 'test@example.test'}]}
            if '/documents/' in url and method == 'GET':
                return {'fields': {'role': {'stringValue': 'teacher'}, 'other': {'stringValue': 'keep'}}}
            if 'recaptchaenterprise' in url:
                if method == 'GET': return {'keys': []}
                return {'name': f'projects/{PROJECT}/keys/public-key'}
            if 'cloudbuild.googleapis.com' in url:
                return {'serviceAccountEmail': f'projects/{PROJECT}/serviceAccounts/123456-compute@developer.gserviceaccount.com'}
            if url.endswith('/config'):
                return firebase
            if 'sites/' in url or 'iam.googleapis.com' in url:
                return {'name': 'already-exists'}
            return {}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'scripts').mkdir(); (root / 'public').mkdir(); (root / 'functions').mkdir()
            (root / 'firebase.json').write_text(json.dumps({'hosting': {'public': 'public'}}))
            with patch.object(prepare, 'api', api), patch.object(prepare, 'gcloud', lambda *a: commands.append(a) or ''), patch.object(prepare, '__file__', str(root / 'scripts/cloud-shell-prepare.py')):
                prepare.prepare(ARGS, '123456')
            config = (root / 'public/config.js').read_text()
            self.assertIn('"emulator": false', config)
            self.assertIn('recaptcha-enterprise', config)
            self.assertNotIn('private_key', config)
            self.assertEqual(json.loads((root / 'firebase.json').read_text())['hosting']['site'], PROJECT)
        self.assertTrue(all(method != 'DELETE' for method, _, _ in requests))
        self.assertTrue(all('jin-gallery/' not in url for _, url, _ in requests))
        self.assertTrue(all('delete' not in c and 'deploy' not in c for c in commands))
        patch_url = next(url for method, url, _ in requests if method == 'PATCH' and '/documents/' in url)
        self.assertIn('updateMask.fieldPaths=role', patch_url)
        self.assertIn('updateMask.fieldPaths=classIds', patch_url)
        self.assertNotIn('updateMask.fieldPaths=other', patch_url)
        key_body = next(body for method, url, body in requests if method == 'POST' and 'recaptchaenterprise' in url)
        self.assertEqual(key_body['webSettings']['integrationType'], 'SCORE')
        self.assertFalse(key_body['webSettings']['allowAllDomains'])

    def test_existing_student_role_is_not_promoted(self):
        def api(method, url, body=None):
            if '/documents/' in url:
                return {'fields': {'role': {'stringValue': 'student'}}}
            if '/databases/' in url:
                return {'type': 'FIRESTORE_NATIVE'}
            if 'accounts:lookup' in url:
                return {'users': [{'localId': ARGS.teacher_uid, 'email': 'test@example.test'}]}
            return {}
        with patch.object(prepare, 'api', api), patch.object(prepare, 'gcloud', lambda *a: ''):
            with self.assertRaisesRegex(RuntimeError, '기존 계정 역할'):
                prepare.prepare(ARGS, '123456')

    def test_shell_requires_explicit_deploy_confirmation(self):
        shell = Path('scripts/cloud-shell-deploy.sh').read_text()
        self.assertIn('"$GALLERY_APPROVAL" != \'DEPLOY\'', shell)
        self.assertIn('--project jin-gallery-v2', shell)
        self.assertNotIn('--force', shell)
        self.assertNotIn('functions:delete', shell)

if __name__ == '__main__':
    unittest.main()
