ALTER TABLE accounts ADD COLUMN position TEXT
  CHECK (position IS NULL OR position IN ('product_lead','operations_lead','operations_assistant','amazon_operator'));
