import { defineAgent } from "eve";
import { fixtureModel } from "./lib/model";

export default defineAgent({
  defaultTools: false,
  model: fixtureModel(false),
  // Mock models have no remote model catalog; declare the context limit.
  modelContextWindowTokens: 64_000,
});
