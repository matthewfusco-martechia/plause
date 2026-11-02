import { defineAgent, defineDynamic } from "eve";
import { fixtureModel } from "./lib/model";

export default defineAgent({
  defaultTools: false,
  model: defineDynamic(() => ({
    model: fixtureModel("root"),
    modelContextWindowTokens: 20_000,
  })),
});
