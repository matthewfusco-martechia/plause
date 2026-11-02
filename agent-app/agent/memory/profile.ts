import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import {
  preserveProfileMemoryCancellation,
  resolveProfileMemoryBackend,
  resolveProfileMemoryScope,
} from "../lib/profile-memory";
const provider = preserveProfileMemoryCancellation(
  fileMemory({ backend: resolveProfileMemoryBackend() })
);

export default defineMemory({
  description: "Remember stable facts and preferences about the current user.",
  provider,
  scope: resolveProfileMemoryScope,
});
