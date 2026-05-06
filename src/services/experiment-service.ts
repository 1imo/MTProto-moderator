import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../utils/logger.js";

// Filename only: lives next to manifest.json inside the experiment directory.
const safeBasename = z
  .string()
  .min(1)
  .refine((s) => !s.includes("/") && !s.includes("\\") && s !== "." && s !== "..", {
    message: "must be a bare filename within the experiment directory"
  });

// Relative path from the experiment dir (allows ../sibling-folder/file); resolved path must stay under dirname(experiment dir).
const safeRelFromExperiment = z
  .string()
  .min(1)
  .refine((s) => !path.isAbsolute(s), { message: "blockFile must be a relative path" });

const manifestSchema = z.object({
  experiment: z.string().min(1),
  variants: z
    .array(
      z.object({
        id: z.string().min(1),
        file: safeBasename,
        blockFile: safeRelFromExperiment.optional(),
        media: safeBasename.optional(),
        weight: z.number().int().nonnegative()
      })
    )
    .min(1)
});

// Telegram caption hard limit. Keep a small buffer for {{SESSION_USERNAME}} substitution.
const TELEGRAM_CAPTION_MAX = 1024;
const CAPTION_SUBSTITUTION_BUFFER = 64;

/** Same key for all moderation tiers so digest % totalWeight pairs tier-2 and tier-3 when both use the same weight sum. */
const MODERATION_FLOW_SUBJECT_PREFIX = "moderation_flow_2026_05";

type LoadedVariant = {
  id: string;
  weight: number;
  html: string;
  blockHtml?: string;
  mediaPath?: string;
};

type LoadedExperiment = {
  experimentId: string;
  variants: LoadedVariant[];
  totalWeight: number;
};

export type Assignment = {
  experimentId: string;
  variantId: string;
  html: string;
  blockHtml?: string;
  mediaPath?: string;
};

/**
 * Loads experiment manifests at boot and assigns variants deterministically.
 * - Assignment is a pure function of (experimentId, subjectId): no persistence required,
 *   so warning-side and block-side analytics events stamp identical variants for the same sender.
 * - Empty/missing variant files cause boot-time failure rather than silent empty messages at runtime.
 */
export class ExperimentService {
  private readonly experiments = new Map<string, LoadedExperiment>();

  constructor(experimentDirs: string[], logger: Logger) {
    for (const dir of experimentDirs) {
      const exp = this.loadExperiment(dir);
      if (this.experiments.has(exp.experimentId)) {
        throw new Error(`duplicate_experiment_id: ${exp.experimentId} (dir=${dir})`);
      }
      this.experiments.set(exp.experimentId, exp);
      logger.info("experiment_loaded", {
        experimentId: exp.experimentId,
        totalWeight: exp.totalWeight,
        variants: exp.variants.map((v) => ({
          id: v.id,
          weight: v.weight,
          bytes: v.html.length,
          hasBlock: Boolean(v.blockHtml),
          hasMedia: Boolean(v.mediaPath)
        }))
      });
    }
  }

  assign(experimentId: string, subjectId: string): Assignment {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`unknown_experiment: ${experimentId}`);
    const bucket = this.hashToBucket(`${experimentId}:${subjectId}`, exp.totalWeight);
    return this.pickWeightedForBucket(exp, bucket);
  }

  /**
   * Deterministic tier pick for the 3-step DM flow (message-warning → message-warning-final → messages-block).
   * Hash input omits experimentId so tiers with identical total weights (e.g. 2 vs 2) reuse the same variant slot.
   */
  assignModerationTier(experimentId: string, subjectId: string): Assignment {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`unknown_experiment: ${experimentId}`);
    const bucket = this.hashToBucket(`${MODERATION_FLOW_SUBJECT_PREFIX}:${subjectId}`, exp.totalWeight);
    return this.pickWeightedForBucket(exp, bucket);
  }

  private pickWeightedForBucket(exp: LoadedExperiment, bucket: number): Assignment {
    const { experimentId } = exp;
    let cursor = 0;
    for (const v of exp.variants) {
      cursor += v.weight;
      if (bucket < cursor) {
        return {
          experimentId,
          variantId: v.id,
          html: v.html,
          blockHtml: v.blockHtml,
          mediaPath: v.mediaPath
        };
      }
    }
    const fallback = exp.variants[0];
    return {
      experimentId,
      variantId: fallback.id,
      html: fallback.html,
      blockHtml: fallback.blockHtml,
      mediaPath: fallback.mediaPath
    };
  }

  private resolveUnderMessagesBundle(experimentDir: string, relPath: string): string {
    const bundleRoot = path.resolve(experimentDir, "..");
    const resolved = path.resolve(experimentDir, relPath.replaceAll("\\", path.sep));
    const rel = path.relative(bundleRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`experiment_path_escape: ${relPath} -> ${resolved} (bundle=${bundleRoot})`);
    }
    return resolved;
  }

  private loadExperiment(dir: string): LoadedExperiment {
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`experiment_manifest_missing: ${manifestPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const manifest = manifestSchema.parse(raw);

    const enabled = manifest.variants.filter((v) => v.weight > 0);
    if (enabled.length === 0) {
      throw new Error(`experiment_has_no_active_variants: ${manifest.experiment}`);
    }

    const withBlockFile = enabled.filter((x) => x.blockFile !== undefined && x.blockFile.trim() !== "");
    if (withBlockFile.length > 0 && withBlockFile.length !== enabled.length) {
      throw new Error(
        `experiment_blockFile_mismatch: ${manifest.experiment} (blockFile required on every variant when used)`
      );
    }

    const variants: LoadedVariant[] = enabled.map((v) => {
      const filePath = path.join(dir, v.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `experiment_variant_file_missing: ${manifest.experiment}/${v.id} -> ${filePath}`
        );
      }
      const html = fs.readFileSync(filePath, "utf8");
      if (html.trim().length === 0) {
        throw new Error(
          `experiment_variant_file_empty: ${manifest.experiment}/${v.id} -> ${filePath}`
        );
      }

      let blockHtml: string | undefined;
      if (v.blockFile) {
        const blockPath = this.resolveUnderMessagesBundle(dir, v.blockFile);
        if (!fs.existsSync(blockPath)) {
          throw new Error(
            `experiment_variant_block_file_missing: ${manifest.experiment}/${v.id} -> ${blockPath}`
          );
        }
        blockHtml = fs.readFileSync(blockPath, "utf8");
        if (blockHtml.trim().length === 0) {
          throw new Error(
            `experiment_variant_block_file_empty: ${manifest.experiment}/${v.id} -> ${blockPath}`
          );
        }
      }

      let mediaPath: string | undefined;
      if (v.media) {
        mediaPath = path.join(dir, v.media);
        if (!fs.existsSync(mediaPath)) {
          throw new Error(
            `experiment_variant_media_missing: ${manifest.experiment}/${v.id} -> ${mediaPath}`
          );
        }
        if (fs.statSync(mediaPath).size === 0) {
          throw new Error(
            `experiment_variant_media_empty: ${manifest.experiment}/${v.id} -> ${mediaPath}`
          );
        }
        // Telegram clamps captions on media messages; fail at boot rather than have gramjs truncate.
        if (html.length + CAPTION_SUBSTITUTION_BUFFER > TELEGRAM_CAPTION_MAX) {
          throw new Error(
            `experiment_variant_caption_too_long: ${manifest.experiment}/${v.id} ` +
              `(${html.length} chars; limit ${TELEGRAM_CAPTION_MAX - CAPTION_SUBSTITUTION_BUFFER})`
          );
        }
      }

      return { id: v.id, weight: v.weight, html, blockHtml, mediaPath };
    });

    const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
    return { experimentId: manifest.experiment, variants, totalWeight };
  }

  private hashToBucket(key: string, modulo: number): number {
    const digest = createHash("sha256").update(key).digest();
    return digest.readUInt32BE(0) % modulo;
  }
}
