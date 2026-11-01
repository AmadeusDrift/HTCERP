CREATE TABLE service_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, lane TEXT NOT NULL,
  owner TEXT NOT NULL, run_id TEXT, attempt INTEGER, active INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL
);
CREATE INDEX service_tickets_lane ON service_tickets(lane,active,expires);
CREATE TABLE service_turns(lane TEXT NOT NULL,owner TEXT NOT NULL,turn INTEGER NOT NULL,PRIMARY KEY(lane,owner));
CREATE TRIGGER service_grant AFTER UPDATE OF active ON service_tickets WHEN NEW.active=1 AND OLD.active=0 BEGIN
 INSERT INTO service_turns(lane,owner,turn) VALUES(NEW.lane,NEW.owner,
   (SELECT COALESCE(MAX(turn),0)+1 FROM service_turns WHERE lane=NEW.lane))
 ON CONFLICT(lane,owner) DO UPDATE SET turn=excluded.turn;
END;
CREATE TABLE public_amazon_offers(asin TEXT PRIMARY KEY,quote TEXT NOT NULL,checked_at INTEGER NOT NULL);
CREATE TABLE public_amazon_searches(query_key TEXT PRIMARY KEY,result TEXT NOT NULL,checked_at INTEGER NOT NULL);
CREATE TABLE dispatch_durations(id INTEGER PRIMARY KEY,lane TEXT NOT NULL,seconds INTEGER NOT NULL);
