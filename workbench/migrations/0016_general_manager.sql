ALTER TABLE accounts ADD COLUMN next_position TEXT CHECK (
  next_position IS NULL OR next_position IN ('general_manager','product_lead','operations_lead','operations_assistant','amazon_operator')
);
UPDATE accounts SET next_position=position;
ALTER TABLE accounts DROP COLUMN position;
ALTER TABLE accounts RENAME COLUMN next_position TO position;
