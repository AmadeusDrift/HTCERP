"""Import public USPTO daily XML and GovInfo search metadata into a local SQLite library."""
import argparse
import hashlib
import json
import re
import sqlite3
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

CATEGORIES = dict(x.split(':') for x in (
    '003:个护清洁 005:医药卫生 006:金属五金 007:机械及电动工具 008:手工具 '
    '009:电子数码 010:医疗器械 011:家电灯具 012:交通工具及配件 014:珠宝钟表 '
    '015:乐器 016:文具纸品 018:包袋皮具 020:家具收纳 021:厨具家居 '
    '022:绳网帐篷 024:家纺面料 025:服饰鞋帽 026:服饰辅料 027:地毯墙饰 '
    '028:玩具运动 029:加工食品 030:食品调味 031:园艺宠物食品'
).split())

def brand_key(value):
    return ' '.join(unicodedata.normalize('NFKC', value).upper().split())

def snapshot(case):
    h = case.find('case-file-header')
    serial = case.findtext('serial-number')
    if h is None or not serial:
        raise ValueError('Missing serial number or header')
    codes = set()
    for group in case.findall('classifications/classification'):
        if group.findtext('status-code') == '6':
            codes.update(c.text.zfill(3) for c in group.findall('international-code') if c.text)
    cats = sorted(codes & CATEGORIES.keys())
    word = h.findtext('mark-identification') or ''
    reg = (case.findtext('registration-number') or '').lstrip('0')
    status = h.findtext('status-code') or ''
    drawing = h.findtext('mark-drawing-code') or ''
    if not (brand_key(word) and cats and reg and status in {'700','800'} and drawing in {'1','3','4','5'}):
        return serial, None
    goods = []
    for line in case.findall('case-file-statements/case-file-statement'):
        typ = line.findtext('type-code') or ''
        if typ.startswith('GS') and typ[2:5] in cats:
            goods.append(typ[2:5] + ' ' + (line.findtext('text') or ''))
    parties = case.findall('case-file-owners/case-file-owner')
    top = max((int(o.findtext('party-type') or 0) for o in parties), default=0)
    owners = sorted({o.findtext('party-name') or '' for o in parties if int(o.findtext('party-type') or 0)==top})
    return serial, (serial,reg,word,brand_key(word),' / '.join(owners),status,h.findtext('status-date'),
                    drawing,'|'.join(cats),' / '.join(CATEGORIES[c] for c in cats),'\n'.join(goods))

def import_zip(db, file, digest):
    with file.open('rb') as source:
        actual = hashlib.file_digest(source,'sha256').hexdigest()
    if actual != digest:
        raise ValueError('SHA256 mismatch: '+file.name)
    if db.execute('SELECT 1 FROM imports WHERE name=? AND sha=?',(file.name,digest)).fetchone():
        return
    with db, zipfile.ZipFile(file) as z:
        xml, = (n for n in z.namelist() if n.lower().endswith('.xml'))
        count = 0
        with z.open(xml) as raw:
            for _,case in ET.iterparse(raw,events=('end',)):
                if case.tag != 'case-file':
                    continue
                serial, row = snapshot(case)
                prior = db.execute('SELECT batch FROM seen WHERE serial=?',(serial,)).fetchone()
                if prior is None or file.name >= prior[0]:
                    db.execute('INSERT OR REPLACE INTO seen VALUES(?,?)',(serial,file.name))
                    db.execute('DELETE FROM marks WHERE serial=?',(serial,))
                    if row:
                        db.execute('INSERT INTO marks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',row+(file.name,))
                count += 1
                case.clear()
        if not count:
            raise ValueError('Empty USPTO file')
        db.execute('INSERT OR REPLACE INTO imports VALUES(?,?,?)',(file.name,digest,count))
    print(file.name,count,flush=True)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache',type=Path,required=True)
    p.add_argument('--db',type=Path,required=True)
    p.add_argument('--days',type=int,default=7)
    args=p.parse_args()
    if args.days<1: p.error('--days must be positive')
    args.db.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(args.db)
    db.executescript('''
    CREATE TABLE IF NOT EXISTS imports(name TEXT PRIMARY KEY,sha TEXT,raw_cases INTEGER);
    CREATE TABLE IF NOT EXISTS seen(serial TEXT PRIMARY KEY,batch TEXT);
    CREATE TABLE IF NOT EXISTS marks(serial TEXT PRIMARY KEY,reg TEXT,word TEXT,brand_key TEXT,owner TEXT,
        status TEXT,status_date TEXT,drawing TEXT,classes TEXT,categories TEXT,goods TEXT,batch TEXT);
    CREATE INDEX IF NOT EXISTS ix_brand ON marks(brand_key);
    CREATE TABLE IF NOT EXISTS gov_candidates(doc_id TEXT PRIMARY KEY,case_id TEXT,title TEXT,
        issued TEXT,modified TEXT,court TEXT,url TEXT);
    CREATE TABLE IF NOT EXISTS court_review_receipts(doc_id TEXT PRIMARY KEY,reviewed_modified TEXT);
    CREATE VIEW IF NOT EXISTS case_review_queue AS
        SELECT g.* FROM gov_candidates g LEFT JOIN court_review_receipts r ON r.doc_id=g.doc_id
        WHERE r.doc_id IS NULL OR r.reviewed_modified IS NOT g.modified;
    ''')
    index=json.loads((args.cache/'bronze_index.json').read_text('utf-8-sig'))
    files=sorted((x for x in index if re.fullmatch(r'daily/apc\d{6}\.zip',x['path'])),key=lambda x:x['path'])
    # Replay all locally available files as well, to recover any formerly missed days.
    for item in files:
        file=args.cache/Path(item['path']).name
        if file.exists() or item in files[-args.days:]:
            import_zip(db,file,item['lfs']['oid'])
    search=json.loads((args.cache/'gsearch.json').read_text('utf-8-sig'))
    with db:
        for r in search['results']:
            doc=r.get('granuleId')
            if not doc: continue
            package=r['packageId']
            db.execute('''INSERT INTO gov_candidates VALUES(?,?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET
                case_id=excluded.case_id,title=excluded.title,issued=excluded.issued,
                modified=excluded.modified,court=excluded.court,url=excluded.url
                WHERE excluded.modified>=gov_candidates.modified''',
                (doc,package,r['title'],r['dateIssued'],r['lastModified'],' / '.join(r['governmentAuthor']),
                 f'https://www.govinfo.gov/content/pkg/{package}/pdf/{doc}.pdf'))
    db.close()
if __name__=='__main__':
    main()
