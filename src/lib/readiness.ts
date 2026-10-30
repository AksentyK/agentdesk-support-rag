import { settings } from "./settings";
import { validateModels } from "./router";
import { publicError } from "./errors";
export const modelReadiness: { state: string; message?: string } = {
  state: "not-checked",
};
export async function checkStartupModels() {
  if (!process.env.ROUTERAI_API_KEY) {
    modelReadiness.state = "key-missing";
    return;
  }
  try {
    await validateModels(await settings());
    modelReadiness.state = "ready";
    delete modelReadiness.message;
  } catch (error) {
    modelReadiness.state = "unavailable";
    modelReadiness.message = publicError(error).error;
    console.warn(
      "RouterAI model validation unavailable; select available models in settings.",
    );
  }
}
