CREATE TABLE IF NOT EXISTS daily_sales_year_baselines (
  sale_date TEXT NOT NULL,
  hours INTEGER NOT NULL CHECK (hours IN (7, 15, 20, 24)),
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  start_at TEXT,
  end_at TEXT,
  imported_at TEXT NOT NULL,
  CHECK ((start_at IS NULL AND end_at IS NULL) OR
    (start_at IS NOT NULL AND end_at IS NOT NULL AND start_at < end_at)),
  PRIMARY KEY (sale_date, hours, source)
);
CREATE INDEX IF NOT EXISTS daily_sales_year_baselines_window ON daily_sales_year_baselines(start_at, end_at, source)
  WHERE start_at IS NOT NULL AND end_at IS NOT NULL;
