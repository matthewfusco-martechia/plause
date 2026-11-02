import { DefaultSandbox, defineSandbox } from "eve/sandbox";

// These fixtures test orchestration, not sandbox commands. Never install an
// optional runtime dependency into a fixture that links the app's node_modules.
export const environment = DefaultSandbox.environment({
  justBash: { autoInstall: false },
});
export default defineSandbox(() => environment.open());
