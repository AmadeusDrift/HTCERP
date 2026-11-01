"""Multi-key, US-market capability sampling. Status only unless --execute is passed."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import time

import geekbi_probe as core

BASE = 'https://openapi.geekbi.com'
ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'probe-output' / 'expanded'


class KeyPool:
    def __init__(self, keys, directory):
        self.entries = []
        identities = set()
        directory.mkdir(parents=True, exist_ok=True)
        for item in keys:
            identity = hashlib.sha256(item['key'].encode()).hexdigest()
            if identity in identities:
                raise ValueError('Duplicate app key: one key cannot receive multiple budgets.')
            identities.add(identity)
            budget = core.Budget(directory / (identity + '.json'), item['budget'])
            self.entries.append(({'GB_APP_KEY': item['key'], 'GB_APP_SECRET': item['secret'],
                                  'GB_BASE_URL': BASE}, budget, item['label']))

    def choose(self, cost):
        for config, budget, label in self.entries:
            if budget.used + cost <= budget.limit:
                return config, budget, label
        raise RuntimeError('Configured point budgets exhausted. No more requests sent.')

    def status(self):
        return [{'label': label, 'budget': budget.limit, 'reserved': budget.used,
                 'remaining': max(0, budget.limit-budget.used)} for _, budget, label in self.entries]


def credentials():
    values = {}
    for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines():
        if line.strip() and not line.lstrip().startswith('#') and '=' in line:
            name, value = line.split('=', 1)
            values[name.strip()] = value.strip().strip('\"\'')
    keys = []
    for index in range(1, 5):
        suffix = '' if index == 1 else '_' + str(index)
        key = values.get('GB_APP_KEY' + suffix, '')
        secret = values.get('GB_APP_SECRET' + suffix, '')
        if bool(key) != bool(secret):
            raise ValueError(f'key{index}: both App Key and App Secret are required.')
        if not key:
            continue
        limit = int(values.get(f'GB_BUDGET_{index}', '250' if index == 1 else '1000'))
        if not 0 <= limit <= 1000:
            raise ValueError(f'key{index}: budget must be between 0 and 1000.')
        keys.append({'label': f'key{index}', 'key': key, 'secret': secret, 'budget': limit})
    if not keys:
        raise ValueError('No complete credentials configured.')
    return keys


def us_site(sites, id_field='siteId'):
    names = {'美国', '美国站', 'united states', 'united states of america', 'usa', 'us'}
    hits = {s[id_field] for s in sites if any(str(s.get(k, '')).strip().lower() in names for k in ['name', 'cnName'])}
    if len(hits) > 1:
        raise RuntimeError('Ambiguous US site; manual review required.')
    return next(iter(hits)) if hits else None


def discovery_plan(sites, categories):
    jobs = []
    def add(platform, group, **params):
        jobs.append({'platform': platform, 'group': group,
                     'path': f'/api/v2/data/{platform}/goods/search', 'cost': 10,
                     'params': {'siteId': sites[platform], 'page': 1, 'size': 200, **params}})
    if 'temu' in sites:
        for category in categories[:12]:
            for sort in ['daySold', 'onSaleTime']:
                for page in [1, 2, 3]:
                    add('temu', 'category-' + str(category['catId']) + '-' + sort,
                        catIds=str(category['catId']), sort=sort, order='desc', page=page)
    words = ['storage organizer', 'pet toy', 'craft supplies', 'kitchen tools',
             'desk accessories', 'garden decor', 'car accessories', 'party supplies']
    for platform in ['temu', 'shein', 'tiktok', 'aliexpress']:
        if platform not in sites:
            continue
        for word in words:
            for page in [1, 2]:
                add(platform, 'keyword-' + word, keyword=word, page=page)
        if platform in ['tiktok', 'aliexpress']:
            for page, size in [(1, 20), (2, 20), (3, 20), (2, 100)]:
                add(platform, 'pagination-diagnostic', keyword='pet toy', page=page, size=size)
    return jobs


def call(pool, job):
    fingerprint = hashlib.sha256(json.dumps([job['path'], job['params']], sort_keys=True).encode()).hexdigest()
    file = OUT / 'responses' / (fingerprint + '.json')
    if file.exists():
        record = json.loads(file.read_text(encoding='utf-8'))
    else:
        config, budget, label = pool.choose(job['cost'])
        result = core.request(config, job['path'], job['params'], budget, job['cost'])
        record = {'job': job, 'key_label': label, 'response': result}
        core.save(file, record)
        time.sleep(1)
    result = record['response']
    status, body = result['http_status'], result['body']
    # Do not rotate keys to work around server quota, authentication or rate limits.
    if status == 402:
        raise RuntimeError('Server reports insufficient credits; stopped for balance review.')
    ok = core.check_response(result, job['cost'])
    if not ok:
        raise RuntimeError(f"{job['platform']} {job['group']} failed; response saved. Review before continuing.")
    return body.get('data'), file.name


def detail_plan(products, sites, region_id):
    jobs = []
    # Cover depth across US platforms, then use remaining budget on Temu.
    candidates = {}
    for platform in ['temu', 'tiktok', 'aliexpress']:
        candidates[platform] = sorted(products.get(platform, {}).values(),
                                      key=lambda g: (g.get('daySold') or 0, g.get('monthSold') or 0), reverse=True)
    order = []
    for start, end in [(0, 20), (20, 40)]:
        for platform in ['temu', 'tiktok', 'aliexpress']:
            order.extend((platform, row) for row in candidates[platform][start:end])
    order.extend(('temu', row) for row in candidates['temu'][40:240])
    # Retain a stable detail queue so subsequent runs can reuse every response.
    for platform, row in order:
        params = {'goodsId': str(row['goodsId'])}
        params.update({'regionId': region_id} if platform == 'temu' else {'siteId': sites[platform]})
        jobs.append({'platform': platform, 'group': 'detail-history', 'cost': 10,
                     'path': f'/api/v2/data/{platform}/goods/detail', 'params': params})
    return jobs


def export(products, results, pool):
    core.save(OUT / 'progress.json', {'keys': pool.status(),
              'platform_unique_goods': {p: len(v) for p, v in products.items()}, 'requests': results})
    fields = ['platform', 'goodsId', 'goodsName', 'linkUrl', 'minPrice', 'daySold',
              'weekSold', 'monthSold', 'daySoldRate', 'weekSoldRate', 'monthSoldRate', 'updateTime']
    with (OUT / 'products.csv').open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fields, extrasaction='ignore')
        writer.writeheader()
        for platform, goods in products.items():
            for row in goods.values():
                writer.writerow({'platform': platform, **row})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    keys = credentials()
    OUT.mkdir(exist_ok=True)
    lock = OUT / 'running.lock'
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.close(fd)
    try:
        pool = KeyPool(keys, OUT / 'budgets')
        print(json.dumps({'execute': args.execute, 'keys': pool.status(),
                          'scope': 'US only; Temu primary; SHEIN, TikTok Shop, AliExpress supplementary; Amazon excluded'}, ensure_ascii=True), flush=True)
        if not args.execute:
            return
        (OUT / 'responses').mkdir(exist_ok=True)
        sites, meta, results, products = {}, {}, [], {}
        try:
            for platform in ['temu', 'shein', 'tiktok', 'aliexpress']:
                data, _ = call(pool, {'platform': platform, 'group': 'sites', 'cost': 0,
                                     'path': f'/api/v2/data/{platform}/site/list', 'params': {}})
                if not isinstance(data, list):
                    raise RuntimeError('Unexpected site response shape; stopped.')
                id_field = 'id' if platform == 'shein' else 'siteId'
                site_id = us_site(data, id_field=id_field)
                if site_id is not None:
                    sites[platform] = site_id
                    meta[platform] = next(s for s in data if s[id_field] == site_id)
            data, _ = call(pool, {'platform': 'temu', 'group': 'categories', 'cost': 0,
                                  'path': '/api/v2/data/temu/category/list', 'params': {}})
            if not isinstance(data, list):
                raise RuntimeError('Unexpected category response shape; stopped.')
            plan = discovery_plan(sites, data)
            core.save(OUT / 'discovery-plan.json', {'sites': sites, 'categories': data[:12], 'jobs': plan})
            for job in plan:
                data, file = call(pool, job)
                if not isinstance(data, dict) or not isinstance(data.get('list'), list):
                    raise RuntimeError('Unexpected search response shape; stopped.')
                platform = job['platform']; known = products.setdefault(platform, {})
                before = len(known)
                for row in data['list']:
                    if row.get('goodsId') is not None:
                        known[str(row['goodsId'])] = row
                results.append({'file': file, 'platform': platform, 'group': job['group'],
                                'rows': len(data['list']), 'new_ids': len(known)-before})
                export(products, results, pool)
                print(f"{platform} {job['group']} page={job['params']['page']}: {len(data['list'])} rows; {len(known)-before} new", flush=True)
            if 'temu' not in meta or 'regionId' not in meta['temu']:
                raise RuntimeError('Temu region missing; detail calls stopped.')
            jobs = detail_plan(products, sites, meta['temu']['regionId'])
            core.save(OUT / 'detail-plan.json', jobs)
            for job in jobs:
                data, file = call(pool, job)
                if not isinstance(data, dict):
                    raise RuntimeError('Unexpected detail response shape; stopped.')
                history = data.get('history')
                results.append({'file': file, 'platform': job['platform'], 'group': job['group'],
                                'goodsId': job['params']['goodsId'],
                                'history_rows': len(history) if isinstance(history, list) else None})
                export(products, results, pool)
                print(f"{job['platform']} detail: history rows={results[-1]['history_rows']}", flush=True)
        finally:
            export(products, results, pool)
    finally:
        lock.unlink()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, OSError, KeyError, TypeError) as error:
        print(str(error) if isinstance(error, (RuntimeError, ValueError)) else f'Stopped: {type(error).__name__}; review saved state.')
        raise SystemExit(1)
