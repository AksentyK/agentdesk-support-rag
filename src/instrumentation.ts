export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkStartupModels } = await import("./lib/readiness");
    await checkStartupModels();
  }
}
