// Prisma's JS PostgreSQL adapter needs no native query/migration engine.
// Use the pinned official generator API and WASM schema parser, retaining npm integrity checks.
import internals from "@prisma/internals";
const { getGenerators } = internals;
import { createRequire } from "node:module";
const { PrismaClientJsGenerator } = createRequire(import.meta.url)(
  "@prisma/client-generator-js",
);
const generators = await getGenerators({
  schemaPath: "prisma/schema.prisma",
  registry: {
    "prisma-client-js": {
      type: "in-process",
      generator: new PrismaClientJsGenerator({
        cliCommand: "npm run db:generate",
      }),
    },
  },
  skipDownload: true,
  cliCommand: "npm run db:generate",
});
try {
  for (const generator of generators) await generator.generate();
  console.log(
    "Prisma Client generated (WASM schema parser, JS PostgreSQL adapter)",
  );
} finally {
  for (const generator of generators) generator.stop();
}
