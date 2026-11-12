import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["pdf-parse", "mammoth"],
  outputFileTracingIncludes: {
    "/*": [
      "./AgentDesk_Knowledge.md",
      "./RAG_Test_Cases.json",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/pdfjs-dist/wasm/**",
      "./node_modules/@napi-rs/canvas*/**",
    ],
  },
  poweredByHeader: false,
  // Use the TS compiler API instead of spawning tsc --showConfig. The bundled
  // TypeScript 6 CLI exits successfully with empty stdout under the Vercel
  // isolated build runner, which makes Next fail to parse its config.
  experimental: { cpus: 2, useTypeScriptCli: false },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default withWorkflow(config);
