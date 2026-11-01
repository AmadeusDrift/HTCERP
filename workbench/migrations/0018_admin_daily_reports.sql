CREATE TABLE admin_daily_reports (
  run_id TEXT NOT NULL REFERENCES job_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('selection','tracking')),
  day TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  PRIMARY KEY(run_id,kind)
);
CREATE INDEX admin_reports_date ON admin_daily_reports(day DESC,run_id,kind);
