"""Offline, repeatable profile of saved expanded probe responses; never calls APIs."""
import collections
import csv
import datetime as dt
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'probe-output' / 'expanded'
TODAY = dt.date(2026, 10, 31)
TZ = dt.timezone(dt.timedelta(hours=8))


def date_of(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(TZ).date()
    except ValueError:
        return None


def audit():
    goods = collections.defaultdict(dict)
    searches = collections.defaultdict(list)
    histories = collections.defaultdict(list)
    costs = collections.Counter()
    failures = []
    for file in sorted((OUT / 'responses').glob('*.json')):
        record = json.loads(file.read_text(encoding='utf-8'))
        job, response = record['job'], record['response']
        body = response['body']
        if response['http_status'] != 200 or body.get('code') != 0:
            failures.append({'file': file.name, 'key_label': record['key_label'],
                             'http': response['http_status']})
            continue
        platform = job['platform']
        costs[platform] += int(response.get('price_points_header') or 0)
        data = body.get('data')
        if job['path'].endswith('/goods/search'):
            rows = data.get('list', [])
            ids = [str(r['goodsId']) for r in rows if r.get('goodsId') is not None]
            searches[platform].append({'group': job['group'], 'rows': len(rows),
                                       'unique_ids': len(set(ids)), 'file': file.name})
            for row in rows:
                if row.get('goodsId') is None:
                    continue
                identifier = str(row['goodsId'])
                previous = goods[platform].get(identifier)
                # Prefer freshest dated record; ties use the more populated row.
                def rank(r):
                    return (date_of(r.get('updateTime')) or dt.date.min,
                            sum(v is not None for v in r.values()))
                if previous is None or rank(row) > rank(previous):
                    goods[platform][identifier] = row
        elif job['path'].endswith('/goods/detail'):
            current = data.get('goods') or {}
            history = data.get('history') or []
            dates = {d for r in history if (d := date_of(r.get('createTime'))) is not None}
            needed = {TODAY-dt.timedelta(days=i) for i in range(7)}
            histories[platform].append({'goodsId': str(job['params']['goodsId']),
                'history_rows': len(history), 'history_dates': len(dates),
                'history_start': str(min(dates)) if dates else None,
                'history_end': str(max(dates)) if dates else None,
                'last7_dates': len(dates & needed),
                'span_missing_dates': (max(dates)-min(dates)).days+1-len(dates) if dates else None,
                'history_daySold_present': sum(r.get('daySold') is not None for r in history),
                'update_date': str(date_of(current.get('updateTime'))), 'file': file.name})
    summary = {}
    for platform, mapping in goods.items():
        rows = list(mapping.values())
        dates = [d for r in rows if (d := date_of(r.get('updateTime'))) is not None]
        fields = {}
        for key in ['minPrice', 'daySold', 'weekSold', 'monthSold', 'goodsScore', 'onSaleTime', 'sku']:
            present = [r[key] for r in rows if r.get(key) is not None]
            fields[key] = {'present': len(present), 'missing': len(rows)-len(present),
                           'zero': sum(v == 0 for v in present),
                           'present_pct': round(100*len(present)/len(rows), 2)}
        history = histories[platform]
        summary[platform] = {'unique_goods': len(rows), 'search_calls': len(searches[platform]),
            'returned_rows': sum(r['rows'] for r in searches[platform]),
            'empty_search_calls': sum(r['rows'] == 0 for r in searches[platform]),
            'record_update_today': sum(d == TODAY for d in dates),
            'record_update_last3_calendar_days': sum(0 <= (TODAY-d).days <= 2 for d in dates),
            'future_update_dates': sum(d > TODAY for d in dates),
            'invalid_or_missing_update': len(rows)-len(dates),
            'fields': fields, 'detail_calls': len(history),
            'history_nonempty': sum(r['history_rows'] > 0 for r in history),
            'history_rows_median': statistics.median(r['history_rows'] for r in history) if history else None,
            'history_last7_dates_complete': sum(r['last7_dates'] == 7 for r in history),
            'observed_price_header_points': costs[platform], 'details': history}
    budgets = []
    for file in (OUT / 'budgets').glob('*.json'):
        budgets.append(json.loads(file.read_text())['reserved_points'])
    result = {'as_of_beijing_date': str(TODAY),
              'scope': 'US exploratory sample; targeted categories and keywords, not a market census',
              'grain': 'platform + goodsId; freshest dated search row, ties prefer more populated row',
              'reserved_points_expanded_phase': sum(budgets),
              'observed_price_header_points': sum(costs.values()),
              'platforms': summary, 'failures_in_response_cache': failures}
    with (OUT / 'products-reviewed.csv').open('w', encoding='utf-8-sig', newline='') as handle:
        fields = ['platform', 'goodsId', 'goodsName', 'linkUrl', 'minPrice', 'daySold',
                  'weekSold', 'monthSold', 'daySoldRate', 'weekSoldRate', 'monthSoldRate',
                  'goodsScore', 'reviewNum', 'onSaleTime', 'updateTime']
        writer = csv.DictWriter(handle, fields, extrasaction='ignore')
        writer.writeheader()
        for platform, mapping in goods.items():
            for row in mapping.values():
                writer.writerow({'platform': platform, **row})
    (OUT / 'audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    with (OUT / 'capability-summary.csv').open('w', encoding='utf-8-sig', newline='') as handle:
        fields = ['platform', 'unique_goods', 'search_calls', 'returned_rows', 'record_update_today',
                  'record_update_last3_calendar_days', 'detail_calls', 'history_nonempty',
                  'history_rows_median', 'history_last7_dates_complete', 'observed_price_header_points']
        writer = csv.DictWriter(handle, fields, extrasaction='ignore')
        writer.writeheader()
        for platform, metrics in summary.items():
            writer.writerow({'platform': platform, **metrics})
    names = {'temu': 'Temu', 'shein': 'SHEIN', 'tiktok': 'TikTok Shop', 'aliexpress': 'AliExpress'}
    lines = ['美国站扩大探测结果 — 2026-10-31（北京时间）', '',
             '范围：极鲸云美国站 Temu、SHEIN、TikTok Shop、AliExpress。未调用极鲸云 Amazon 接口；Amazon 后续优先 SP-API。',
             '样本：Temu 前十二个返回的顶级类目与八个生活用品相关英文关键词；其他平台使用相同八个关键词。目标是能力边界探测，不是各平台市场份额或真实成交量验证。',
             '本轮去重口径：平台 + 商品ID；同ID多次返回时，优先较新的更新时间，日期相同时优先字段较完整的记录。日期统一换算北京时间。', '',
             f"扩大阶段保守预留累计 {result['reserved_points_expanded_phase']} 积分；保存成功响应头合计声明扣点 {result['observed_price_header_points']}。网络中断、鉴权失败等仍保守占用预算；实际扣点以控制台账单为准。", '',
             '各平台结果（字段存在不等于精确真实订单，更新时间也不一定是全部指标的观测时间）：']
    for platform in ['temu', 'shein', 'tiktok', 'aliexpress']:
        if platform not in summary:
            continue
        m = summary[platform]
        lines += [f"{names[platform]}：搜索 {m['search_calls']} 次，返回 {m['returned_rows']} 行，去重 {m['unique_goods']} 件；记录当天更新 {m['record_update_today']} 件，近三个自然日更新 {m['record_update_last3_calendar_days']} 件。",
                  f"  日销量字段存在 {m['fields']['daySold']['present_pct']}%，月销量字段存在 {m['fields']['monthSold']['present_pct']}%。",
                  f"  详情样本 {m['detail_calls']} 件，其中 {m['history_nonempty']} 件返回非空历史，历史条数中位数 {m['history_rows_median']}；最近七个自然日每天有历史快照 {m['history_last7_dates_complete']} 件。"]
    lines += ['', '分页核对：',
              'Temu 与 SHEIN 连续两页、每页200条可返回新商品。Temu 多类目多个排序三页样本也有持续新增。',
              'TikTok Shop 与 AliExpress：八个关键词的200条/页首屏均返回200条，第二页为空。pet toy 补测20条/页的第1、2、3页及100条/页第2页均正常返回，total=200。支持分页，但本次关键词命中池约200条；这既不证明全市场只有200件，也不足以确定平台所有查询的统一最大上限。',
              '小页查询偶尔带来少量不同ID，不能假定跨请求排序与候选集合完全不变。', '',
              '初步用途判断：',
              'Temu：本轮批量发现与历史研究证据最充分，可继续作为MVP主要候选来源。仍需保留更新时间和缺失标记，不能把旧增长信号当成当前增长。',
              'SHEIN：本轮搜索的销量等字段较完整，可作为扩展发现来源；当前公开接口目录未提供独立商品详情/历史接口，不能据此承诺历史趋势能力。',
              'TikTok Shop、AliExpress：本轮关键词覆盖与历史较弱，适合作为补充研究来源；尚不足以替代专门的全市场发现和连续趋势数据。', '',
              '限制：详情样本主要按已返回销量排序选择，偏向较高销量，不代表全平台历史覆盖率。未做跨日连续监测、独立来源成交核验、同款规格人工核对或Amazon比价，因此当前结论是数据接入可行性，不是上架推荐。', '',
              '证据：probe-output/expanded/audit.json、capability-summary.csv、products-reviewed.csv，以及 responses 与 failures 目录。审计程序 audit_expanded.py 仅在本地读取文件，不调用接口。']
    (ROOT / '美国站扩大探测结果.txt').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps({'points': result['observed_price_header_points'],
                      'reserved': result['reserved_points_expanded_phase'],
                      'platforms': {p: {k: m[k] for k in ['unique_goods', 'search_calls',
                                    'record_update_today', 'detail_calls', 'history_nonempty']}
                                    for p, m in summary.items()}}, ensure_ascii=True))
    return result


if __name__ == '__main__':
    audit()
