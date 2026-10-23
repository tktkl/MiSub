#!/usr/bin/env python3
"""通过真实 HTTP 接口检查新部署；测试节点使用文档保留地址。"""
import argparse
import base64
import json
from pathlib import Path
import secrets
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['initialize', 'verify', 'cleanup'])
parser.add_argument('--base', default='http://127.0.0.1:18787')
parser.add_argument('--env', default='/opt/misub/service.env')
parser.add_argument('--state', default='/opt/misub/validation')
args = parser.parse_args()
env = dict(line.split('=', 1) for line in Path(args.env).read_text().splitlines() if '=' in line)
origin = env['MISUB_PUBLIC_URL'].rstrip('/')
state = Path(args.state)
state.mkdir(mode=0o700, parents=True, exist_ok=True)
cookie = ''


def request(route, body=None, authenticated=True, user_agent='MiSub-Deployment-Check'):
    headers = {'Origin': origin, 'User-Agent': user_agent}
    if authenticated and cookie:
        headers['Cookie'] = cookie
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(args.base + route, headers=headers,
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def api(route, body=None):
    status, _, content = request(route, body)
    assert status == 200, (route, status, content[:160])
    result = json.loads(content)
    assert result.get('success') is not False, (route, result)
    return result


status, _, content = request('/api/data', authenticated=False)
assert status == 200 and json.loads(content).get('authenticated') is False
status, _, _ = request('/api/misubs', {'misubs': [], 'profiles': []}, authenticated=False)
assert status == 401, ('unauthenticated write', status)
status, headers, content = request('/api/login', {'password': env['ADMIN_PASSWORD']}, False)
assert status == 200 and json.loads(content)['success']
assert 'Secure;' in headers.get('Set-Cookie', '') and 'HttpOnly;' in headers.get('Set-Cookie', '')
cookie = headers['Set-Cookie'].split(';', 1)[0]
assert request('/login')[0] == 200
assert request('/dashboard')[0] == 200
assert api('/api/kv_test')['writeTest']['match']

data = api('/api/data')
fixture_ids = {'deployment-check-ss', 'deployment-check-vless'}

if args.mode == 'initialize':
    assert not data['misubs'] and not data['profiles'], 'New deployment must be empty before initialization'
    (state / 'original-data.json').write_text(json.dumps(data))
    settings = {
        'mytoken': secrets.token_urlsafe(24),
        'profileToken': secrets.token_urlsafe(24),
        'enablePublicPage': False,
        'transformConfigMode': 'builtin',
    }
    api('/api/settings', settings)
    ss_auth = base64.urlsafe_b64encode(b'aes-128-gcm:deployment-verification').decode().rstrip('=')
    nodes = [
        {'id': 'deployment-check-ss', 'name': 'Deployment SS', 'enabled': True,
         'url': f'ss://{ss_auth}@192.0.2.1:8388#Deployment-SS', 'nodeCount': 1},
        {'id': 'deployment-check-vless', 'name': 'Deployment VLESS', 'enabled': True,
         'url': 'vless://00000000-0000-4000-8000-000000000001@192.0.2.2:443?encryption=none&security=tls&type=tcp&sni=example.com#Deployment-VLESS',
         'nodeCount': 1},
    ]
    profile = {'id': 'deployment-check', 'name': 'Deployment Verification', 'enabled': True,
        'isPublic': False, 'subscriptions': [], 'manualNodes': sorted(fixture_ids)}
    api('/api/misubs', {'misubs': nodes, 'profiles': [profile]})
    (state / 'session-cookie').write_text(cookie)
    data = api('/api/data')

if args.mode in ['initialize', 'verify']:
    assert fixture_ids.issubset({item['id'] for item in data['misubs']})
    settings = api('/api/settings')
    profile_path = '/' + settings['profileToken'] + '/deployment-check'
    status, _, content = request(profile_path, authenticated=False, user_agent='Shadowrocket/2.2.90')
    assert status == 200, ('Shadowrocket subscription', status, content[:160])
    text = content.decode()
    try:
        decoded = base64.b64decode(text.strip() + '===', validate=False).decode()
    except (ValueError, UnicodeDecodeError):
        decoded = text
    assert 'ss://' in decoded and 'vless://' in decoded, ('Missing protocols', text[:200])
    assert '192.0.2.1' in decoded and '192.0.2.2' in decoded
    if args.mode == 'verify':
        previous_cookie = (state / 'session-cookie').read_text()
        fresh_cookie = cookie
        cookie = previous_cookie
        assert 'misubs' in api('/api/data'), 'Session did not survive restart'
        cookie = fresh_cookie
    print(json.dumps({'mode': args.mode, 'login': True, 'private_api': True,
        'secure_cookie': True, 'kv_read_write': True, 'shadowrocket_ss_vless': True,
        'persisted_nodes': len(data['misubs'])}))

if args.mode == 'cleanup':
    # 只删除本脚本创建的测试项，保留可能由用户新建的数据。
    remaining_nodes = [node for node in data['misubs'] if node['id'] not in fixture_ids]
    remaining_profiles = [profile for profile in data['profiles'] if profile['id'] != 'deployment-check']
    api('/api/misubs', {'misubs': remaining_nodes, 'profiles': remaining_profiles})
    final = api('/api/data')
    assert not fixture_ids.intersection({node['id'] for node in final['misubs']})
    print(json.dumps({'mode': 'cleanup', 'remaining_nodes': len(final['misubs']),
        'remaining_profiles': len(final['profiles'])}))
