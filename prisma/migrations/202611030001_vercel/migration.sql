ALTER TABLE "EvaluationRun"
  ADD COLUMN executor text NOT NULL DEFAULT 'worker',
  ADD COLUMN "nextBatch" integer NOT NULL DEFAULT 0,
  ADD COLUMN "leaseToken" text,
  ADD COLUMN "leaseExpiresAt" timestamp(3);
CREATE TABLE "DocumentUpload" (
  id text PRIMARY KEY,
  owner text NOT NULL UNIQUE,
  name text NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 20971520),
  "expiresAt" timestamp(3) NOT NULL
);
CREATE TABLE "DocumentUploadPart" (
  "uploadId" text NOT NULL REFERENCES "DocumentUpload"(id) ON DELETE CASCADE,
  index integer NOT NULL CHECK (index >= 0 AND index < 7),
  data bytea NOT NULL CHECK (octet_length(data) <= 3145728),
  PRIMARY KEY ("uploadId", index)
);
