// Check deployment traces, then exercise PDF/DOCX using only packaged dependencies.
import {
  readFile,
  stat,
  copyFile,
  mkdir,
  mkdtemp,
  writeFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = process.cwd();
let apiFiles;
for (const route of ["api/[...path]", ".well-known/workflow/v1/flow"]) {
  const trace = path.join(root, ".next/server/app", route, "route.js.nft.json");
  const files = JSON.parse(await readFile(trace, "utf8")).files.map((file) =>
    path.resolve(path.dirname(trace), file),
  );
  for (const name of [
    "AgentDesk_Knowledge.md",
    "RAG_Test_Cases.json",
    "pdf.worker.mjs",
  ])
    assert(
      files.some((file) => path.basename(file) === name),
      `${route}: missing ${name}`,
    );
  assert(
    files.some((file) => /canvas.*\.node$/.test(file)),
    `${route}: missing native canvas`,
  );
  let bytes = (await stat(trace.replace(".nft.json", ""))).size;
  for (const file of files) bytes += (await stat(file)).size;
  assert(
    bytes < 250 * 1024 * 1024,
    `${route}: exceeds the standard function bundle limit`,
  );
  console.log(
    `${route}: ${Math.ceil(bytes / 1024 / 1024)} MiB traced, required assets present`,
  );
  if (route.startsWith("api/")) apiFiles = files;
}
const isolated = await mkdtemp(path.join(tmpdir(), "agentdesk-vercel-bundle-"));
try {
  for (const file of apiFiles) {
    const relative = path.relative(root, file);
    assert(!relative.startsWith(".."), "Trace escapes project root");
    const target = path.join(isolated, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
  }
  await copyFile(
    "AgentDesk_Manual_35pages.pdf",
    path.join(isolated, "sample.pdf"),
  );
  await copyFile(
    "tests/fixtures/sample.docx",
    path.join(isolated, "sample.docx"),
  );
  await writeFile(
    path.join(isolated, "smoke.mjs"),
    `
    import { PDFParse } from 'pdf-parse';
    import mammoth from 'mammoth';
    import { readFile } from 'node:fs/promises';
    import assert from 'node:assert/strict';
    const parser = new PDFParse({data: await readFile('sample.pdf')});
    try { assert((await parser.getText()).text.includes('AgentDesk')); }
    finally { await parser.destroy(); }
    const docx = await mammoth.extractRawText({buffer: await readFile('sample.docx')});
    assert(docx.value.includes('AgentDesk: проверка DOCX.'));
    console.log('PDF and DOCX parse successfully with traced dependencies only');
  `,
  );
  execFileSync(process.execPath, [path.join(isolated, "smoke.mjs")], {
    cwd: isolated,
    stdio: "inherit",
    env: { ...process.env, NODE_PATH: "" },
  });
} finally {
  await rm(isolated, { recursive: true, force: true });
}
