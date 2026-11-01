CREATE TABLE products (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    market TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_cn TEXT,
    thumbnail TEXT,
    source_url TEXT,
    category_id TEXT,
    category_name TEXT,
    category_path TEXT,
    min_price REAL,
    max_price REAL,
    currency TEXT,
    total_sold INTEGER,
    total_sold_field TEXT,
    day_sold INTEGER,
    week_sold INTEGER,
    month_sold INTEGER,
    rating REAL,
    review_count INTEGER,
    shop_id TEXT,
    shop_name TEXT,
    brand TEXT,
    on_sale_at TEXT,
    updated_at TEXT,
    fetched_at TEXT,
    source TEXT NOT NULL DEFAULT 'geekbi',
    evidence_ref TEXT,
    variants_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(platform,market,external_id)
);
CREATE INDEX products_platform_sales ON products(platform,total_sold DESC,id);
CREATE INDEX products_sales ON products(total_sold DESC,id);
CREATE INDEX products_category ON products(platform,category_id,min_price);
CREATE INDEX products_updated ON products(updated_at DESC,id);

-- Immutable input for the current projection. Both offline and Worker writers use this path.
CREATE TABLE product_snapshots (
    product_id TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
    PRIMARY KEY(product_id,evidence_ref)
);
CREATE TRIGGER project_catalog_snapshot AFTER INSERT ON product_snapshots BEGIN
    INSERT INTO products (
        id,platform,market,external_id,title,title_cn,thumbnail,source_url,category_id,category_name,category_path,min_price,max_price,currency,total_sold,total_sold_field,day_sold,week_sold,month_sold,rating,review_count,shop_id,shop_name,brand,on_sale_at,updated_at,fetched_at,source,evidence_ref,variants_json
    ) VALUES (
        json_extract(NEW.snapshot_json,'$.id'),
        json_extract(NEW.snapshot_json,'$.platform'),
        json_extract(NEW.snapshot_json,'$.market'),
        json_extract(NEW.snapshot_json,'$.external_id'),
        json_extract(NEW.snapshot_json,'$.title'),
        json_extract(NEW.snapshot_json,'$.title_cn'),
        json_extract(NEW.snapshot_json,'$.thumbnail'),
        json_extract(NEW.snapshot_json,'$.source_url'),
        json_extract(NEW.snapshot_json,'$.category_id'),
        json_extract(NEW.snapshot_json,'$.category_name'),
        json_extract(NEW.snapshot_json,'$.category_path'),
        json_extract(NEW.snapshot_json,'$.min_price'),
        json_extract(NEW.snapshot_json,'$.max_price'),
        json_extract(NEW.snapshot_json,'$.currency'),
        json_extract(NEW.snapshot_json,'$.total_sold'),
        json_extract(NEW.snapshot_json,'$.total_sold_field'),
        json_extract(NEW.snapshot_json,'$.day_sold'),
        json_extract(NEW.snapshot_json,'$.week_sold'),
        json_extract(NEW.snapshot_json,'$.month_sold'),
        json_extract(NEW.snapshot_json,'$.rating'),
        json_extract(NEW.snapshot_json,'$.review_count'),
        json_extract(NEW.snapshot_json,'$.shop_id'),
        json_extract(NEW.snapshot_json,'$.shop_name'),
        json_extract(NEW.snapshot_json,'$.brand'),
        json_extract(NEW.snapshot_json,'$.on_sale_at'),
        json_extract(NEW.snapshot_json,'$.updated_at'),
        json_extract(NEW.snapshot_json,'$.fetched_at'),
        json_extract(NEW.snapshot_json,'$.source'),
        json_extract(NEW.snapshot_json,'$.evidence_ref'),
        json_extract(NEW.snapshot_json,'$.variants_json')
    )
    ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        title_cn=excluded.title_cn,
        thumbnail=excluded.thumbnail,
        source_url=COALESCE(excluded.source_url,products.source_url),
        category_id=excluded.category_id,
        category_name=excluded.category_name,
        category_path=excluded.category_path,
        min_price=excluded.min_price,
        max_price=excluded.max_price,
        currency=excluded.currency,
        total_sold=excluded.total_sold,
        total_sold_field=excluded.total_sold_field,
        day_sold=excluded.day_sold,
        week_sold=excluded.week_sold,
        month_sold=excluded.month_sold,
        rating=excluded.rating,
        review_count=excluded.review_count,
        shop_id=excluded.shop_id,
        shop_name=excluded.shop_name,
        brand=excluded.brand,
        on_sale_at=excluded.on_sale_at,
        updated_at=excluded.updated_at,
        fetched_at=excluded.fetched_at,
        source=excluded.source,
        evidence_ref=excluded.evidence_ref,
        variants_json=excluded.variants_json
    WHERE (COALESCE(excluded.updated_at,''),COALESCE(excluded.fetched_at,''))
        > (COALESCE(products.updated_at,''),COALESCE(products.fetched_at,''));
END;

CREATE TABLE observations (
    product_id TEXT NOT NULL REFERENCES products(id),
    observed_at TEXT NOT NULL,
    min_price REAL,
    total_sold INTEGER,
    total_sold_field TEXT,
    day_sold INTEGER,
    week_sold INTEGER,
    month_sold INTEGER,
    rating REAL,
    review_count INTEGER,
    currency TEXT,
    fetched_at TEXT,
    source TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    PRIMARY KEY(product_id,observed_at,evidence_ref)
);
CREATE TABLE category_mappings (
    group_key TEXT NOT NULL,
    platform TEXT NOT NULL,
    category_id TEXT NOT NULL,
    PRIMARY KEY(group_key,platform,category_id)
);
-- Conservative v1 home group, using verified source root IDs. Keywords alone are insufficient.
INSERT INTO category_mappings VALUES
    ('home','temu','9711'),('home','shein','2032'),('home','aliexpress','15'),
    ('home','tiktok','600001'),('home','tiktok','600024');
CREATE TABLE candidates (
    product_id TEXT PRIMARY KEY REFERENCES products(id),
    stage TEXT NOT NULL CHECK(stage IN ('candidate','watch','follow','hold','reject')),
    lines_json TEXT NOT NULL CHECK(json_valid(lines_json)),
    note TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX candidates_stage ON candidates(stage,updated_at DESC);
CREATE TABLE feedback (
    id INTEGER PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    stage TEXT NOT NULL CHECK(stage IN ('candidate','watch','follow','hold','reject')),
    lines_json TEXT NOT NULL,
    note TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX feedback_product ON feedback(product_id,id DESC);
-- One atomic INSERT records the human action and updates the candidate.
CREATE TRIGGER update_candidate AFTER INSERT ON feedback BEGIN
    INSERT INTO candidates(product_id,stage,lines_json,note,updated_by,updated_at)
    VALUES(NEW.product_id,NEW.stage,NEW.lines_json,NEW.note,NEW.author,NEW.created_at)
    ON CONFLICT(product_id) DO UPDATE SET
      stage=excluded.stage,lines_json=excluded.lines_json,note=excluded.note,
      updated_by=excluded.updated_by,updated_at=excluded.updated_at;
END;
