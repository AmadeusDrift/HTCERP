CREATE TABLE notification_infringement_deliveries (
  event_id TEXT PRIMARY KEY REFERENCES notification_infringement_events(id),
  delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE
);
CREATE INDEX notification_infringement_delivery_batch
  ON notification_infringement_deliveries(delivery_id);
