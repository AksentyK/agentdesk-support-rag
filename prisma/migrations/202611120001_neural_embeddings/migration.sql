-- Add a separate, dimension-flexible vector column. Keep the existing LSA
-- vector(256) and its hash intact until the new index has been verified.
ALTER TABLE "Chunk"
  ADD COLUMN "embeddingV2" vector,
  ADD COLUMN "embeddingV2Hash" text,
  ADD COLUMN "embeddingModel" text,
  ADD COLUMN "embeddingDimensions" integer;

ALTER TABLE "Chunk"
  ADD CONSTRAINT "Chunk_embeddingDimensions_positive"
  CHECK ("embeddingDimensions" IS NULL OR "embeddingDimensions" > 0);

-- Deliberately no ANN index yet: RouterAI's measured dimension determines
-- the correct HNSW index definition. Until then retrieval filters by dimension.
