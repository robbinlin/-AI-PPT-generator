import type { JobType } from "@lvs/shared";
import type { JobHandler } from "../context.js";
import { exportScript } from "./export-script.js";
import { makeGenerationHandlers, unimplementedSeams, type GenerationSeams } from "./generation.js";
import { parseDocument } from "./parse-document.js";

/**
 * Registry consumed by the JobRunner. Pass real `seams` once @lvs/pipeline, @lvs/providers
 * and @lvs/render are integrated; until then generation jobs fail fast with NotImplemented.
 */
export function buildHandlers(seams: GenerationSeams = unimplementedSeams): Partial<Record<JobType, JobHandler>> {
  const gen = makeGenerationHandlers(seams);
  return {
    parse_document: parseDocument as JobHandler,
    export_script: exportScript as JobHandler,
    generate_outline: gen.generateOutline as JobHandler,
    generate_script: gen.generateScript as JobHandler,
    synthesize_speech: gen.synthesizeSpeech as JobHandler,
    generate_avatar: gen.generateAvatar as JobHandler,
    render_video: gen.renderVideo as JobHandler,
    translate_script: gen.translateScripts as JobHandler,
  };
}

export type { GenerationSeams } from "./generation.js";
export { unimplementedSeams } from "./generation.js";
