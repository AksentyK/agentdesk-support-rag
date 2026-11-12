-- Optional rollback for the additive neural index migration.
-- Only run after confirming no deployed application uses embeddingV2.
-- The legacy embedding vector(256), embeddingHash, documents and chunks remain.
ALTER TABLE "Chunk"
  DROP CONSTRAINT IF EXISTS "Chunk_embeddingDimensions_positive",
  DROP COLUMN IF EXISTS "embeddingDimensions",
  DROP COLUMN IF EXISTS "embeddingModel",
  DROP COLUMN IF EXISTS "embeddingV2Hash",
  DROP COLUMN IF EXISTS "embeddingV2";
DELETE FROM "_agentdesk_migrations"
WHERE name = '202611120001_neural_embeddings';
