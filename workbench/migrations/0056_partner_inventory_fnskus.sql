CREATE TABLE inventory_source_fnskus (
  generation TEXT NOT NULL,
  sku TEXT NOT NULL,
  fnsku TEXT NOT NULL,
  PRIMARY KEY(generation,sku,fnsku),
  FOREIGN KEY(generation,sku) REFERENCES inventory_source_rows(generation,sku) ON DELETE CASCADE
) WITHOUT ROWID;
