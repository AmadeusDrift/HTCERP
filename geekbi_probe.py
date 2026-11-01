"""Disposable, standard-library-only GeekBI breadth probe. Dry-run by default."""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'probe-output'


class Budget:
    def __init__(self, path, limit):
        self.path, self.limit = path, limit
        self.used = json.loads(path.read_text())['reserved_points'] if path.exists() else 0

    def reserve(self, points):
        if points < 0 or self.used + points > self.limit:
            raise RuntimeError('500-point budget exhausted; no request sent.')
        self.used += points
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'reserved_points': self.used}), encoding='utf-8')
        temporary.replace(self.path)


def build_plan(site_id, categories):
    plan = []
    def add(group, **params):
        plan.append({'id': f'{len(plan)+1:02d}', 'group': group,
                     'params': {'siteId': site_id, 'page': 1, 'size': 50, **params}})
    for size in [20, 50, 100, 200, 500]:
        add('page-size', size=size)
    for page in range(1, 11):
        add('sequential', page=page)
    for page in [20, 50, 100]:
        add('deep-page', page=page)
    for page in range(1, 4):
        for sort in ['daySold', 'onSaleTime']:
            add('sort-' + sort, page=page, sort=sort, order='desc')
    for category in categories[:3]:
        for page in [1, 2, 3]:
            add('category-' + str(category), page=page, catIds=str(category))
    for index in range(8):
        add('cursor', mode='cursor', cursor_step=index)
    for keyword in ['storage', 'pet', 'craft']:
        add('keyword-' + keyword, keyword=keyword)
    return plan


def analyze(data, seen):
    rows = data.get('list', [])
    if not isinstance(rows, list):
        raise RuntimeError('Unexpected list response; inspect saved response.')
    ids = {str(row['goodsId']) for row in rows if isinstance(row, dict) and row.get('goodsId') is not None}
    new = ids - seen
    return {'rows': len(rows), 'unique_ids': len(ids), 'new_ids': len(new),
            'missing_ids': sum(not isinstance(r, dict) or r.get('goodsId') is None for r in rows),
            'duplicate_rows': len(rows) - sum(not isinstance(r, dict) or r.get('goodsId') is None for r in rows) - len(ids),
            'total_reported': data.get('total'), 'hasMore': data.get('hasMore')}, seen | ids


def read_config():
    config = {}
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                name, value = line.split('=', 1)
                config[name.strip()] = value.strip().strip('\"\'')
    for name in ['GB_APP_KEY', 'GB_APP_SECRET', 'GB_BASE_URL']:
        config[name] = os.environ.get(name) or config.get(name, '')
        if not config[name]:
            raise RuntimeError(f'Fill {name} in .env. No request sent.')
    origin = urllib.parse.urlsplit(config['GB_BASE_URL'])
    if origin.scheme != 'https' or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ['', '/']:
        raise RuntimeError('GB_BASE_URL must be an HTTPS service origin without a path.')
    if not origin.hostname or not (origin.hostname == 'geekbi.com' or origin.hostname.endswith('.geekbi.com')):
        raise RuntimeError('API origin must be a verified geekbi.com host.')
    return config


def request(config, path, params, budget, cost):
    query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote_plus)
    timestamp, nonce = str(int(time.time())), secrets.token_hex(16)
    canonical = '\n'.join(['GET', path, query, timestamp, nonce])
    signature = base64.b64encode(hmac.new(config['GB_APP_SECRET'].encode(), canonical.encode(), hashlib.sha256).digest()).decode()
    headers = {'X-GB-App-Key': config['GB_APP_KEY'], 'X-GB-Timestamp': timestamp,
               'X-GB-Nonce': nonce, 'X-GB-Signature': signature}
    url = config['GB_BASE_URL'].rstrip('/') + path + ('?' + query if query else '')
    # Reserve BEFORE sending. Errors and uncertain transport outcomes remain reserved.
    budget.reserve(cost)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    try:
        response = opener.open(urllib.request.Request(url, headers=headers), timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.code
        charged = response.headers.get('X-GB-Price-Points')
        raw = response.read().decode('utf-8', errors='replace')
    for name in ['GB_APP_KEY', 'GB_APP_SECRET']:
        raw = raw.replace(config[name], '[REDACTED]')
    try:
        body = json.loads(raw)
    except ValueError:
        body = {'unparsed': raw[:10000]}
    result = {'http_status': status, 'price_points_header': charged, 'body': body}
    return result


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def check_response(result, cost):
    charged = result['price_points_header']
    if charged is not None:
        try:
            if float(charged) > cost:
                raise RuntimeError('Unexpected price header; stopped for billing review.')
        except ValueError:
            raise RuntimeError('Unrecognized price header; stopped for billing review.')
    status = result['http_status']
    if status in [401, 403, 429] or status >= 500 or 300 <= status < 400:
        raise RuntimeError(f'HTTP {status}; stopped without retry.')
    body = result['body']
    return status == 200 and isinstance(body, dict) and body.get('code') == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help='Send requests; otherwise show sample plan only.')
    parser.add_argument('--market', default='美国', help='Test market matched against live site list.')
    args = parser.parse_args()
    if not args.execute:
        plan = build_plan('FROM_LIVE_SITE_LIST', ['LIVE_CATEGORY_1', 'LIVE_CATEGORY_2', 'LIVE_CATEGORY_3'])
        print(json.dumps({'dry_run': True, 'hard_cap': 500, 'paid_requests_max': len(plan),
                          'planned_points_max': len(plan)*10, 'market_assumption': args.market,
                          'plan': plan}, ensure_ascii=True, indent=2))
        return
    config = read_config()
    OUT.mkdir(exist_ok=True)
    # Prevent parallel processes from sharing and overrunning the ledger.
    lock = OUT / 'running.lock'
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.close(fd)
    try:
        budget = Budget(OUT / 'ledger.json', 500)
        def catalog(name, path):
            file = OUT / (name + '.json')
            if file.exists():
                result = json.loads(file.read_text(encoding='utf-8'))
            else:
                result = request(config, path, {}, budget, 0)
                save(file, result)
            if not check_response(result, 0):
                raise RuntimeError('Catalog failed; inspect saved result before proceeding.')
            return result['body']['data']
        sites = catalog('sites', '/api/v2/data/temu/site/list')
        matches = [s for s in sites if args.market in [s.get('cnName'), s.get('name')]]
        if len(matches) != 1:
            raise RuntimeError('Market not uniquely matched; inspect sites.json.')
        categories = catalog('categories', '/api/v2/data/temu/category/list')
        # Small cross-category sample, NOT a representative market census.
        selected = [c['catId'] for c in categories[:3]]
        plan = build_plan(matches[0]['siteId'], selected)
        plan_file = OUT / 'plan.json'
        if plan_file.exists() and json.loads(plan_file.read_text(encoding='utf-8')) != plan:
            raise RuntimeError('Existing run uses a different plan; do not mix samples.')
        save(plan_file, plan)
        seen, groups, summaries = set(), {}, []
        cursor, cursor_active = None, True
        for item in plan:
            params = dict(item['params'])
            step = params.pop('cursor_step', None)
            if step is not None:
                if not cursor_active:
                    continue
                if step:
                    params['cursor'] = cursor
            file = OUT / (item['id'] + '.json')
            if file.exists():
                record = json.loads(file.read_text(encoding='utf-8'))
                result = record['response']
            else:
                result = request(config, '/api/v2/data/temu/goods/search', params, budget, 10)
                save(file, {'group': item['group'], 'params': params, 'response': result})
                time.sleep(1)
            ok = check_response(result, 10)
            summary = {'id': item['id'], 'group': item['group'], 'params': params, 'success': ok}
            if ok:
                data = result['body'].get('data', {})
                metrics, seen = analyze(data, seen)
                local, groups[item['group']] = analyze(data, groups.get(item['group'], set()))
                summary.update(metrics)
                summary['new_ids_within_group'] = local['new_ids']
                if step is not None:
                    cursor = data.get('cursor')
                    cursor_active = bool(cursor) and data.get('hasMore') is not False
            elif step is not None:
                cursor_active = False
            summaries.append(summary)
            save(OUT / 'summary.json', {'reserved_points': budget.used, 'unique_goods': len(seen),
                 'scope': 'Temu exploratory sample; first three returned root categories', 'requests': summaries})
            print(f"{item['id']} {item['group']}: success={ok}; reserved={budget.used}/500")
        print('Probe finished. Review probe-output/summary.json and raw records.')
    finally:
        lock.unlink()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        # Deliberately do not print transport errors or URLs containing credentials.
        if isinstance(error, RuntimeError):
            print(str(error))
        else:
            print(f'Stopped: {type(error).__name__}. No automatic retry.')
        raise SystemExit(1)
