export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    const { checkStartupModels } = await import("./lib/readiness");
    await checkStartupModels();
  }
}
