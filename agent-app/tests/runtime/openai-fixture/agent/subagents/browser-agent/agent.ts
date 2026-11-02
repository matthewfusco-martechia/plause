import { defineAgent, defineDynamic } from "eve";
import { fixtureModel } from "../../lib/model";

export default defineAgent({
  description: "Offline direct OpenAI worker fixture",
  defaultTools: false,
  tool: false,
  model: defineDynamic(() => ({
    model: fixtureModel("browser"),
    modelContextWindowTokens: 20_000,
  })),
});
