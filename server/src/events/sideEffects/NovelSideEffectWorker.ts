import {registerTaskCancellation, withExecutionSignal} from "../../platform/runtime/execution";
import os from "node:os";
import { NovelSideEffectJobService, novelSideEffectJobService, NovelSideEffectLeaseLostError } from "./NovelSideEffectJobService";
import {
  NovelSideEffectJobHandlers,
  UnsupportedNovelSideEffectPayloadError,
} from "./NovelSideEffectJobHandlers";

function resolveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface NovelSideEffectWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
}

export class NovelSideEffectWorker {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly pollMs: number;

  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(
    private readonly jobService: NovelSideEffectJobService = novelSideEffectJobService,
    private readonly handlers: NovelSideEffectJobHandlers = new NovelSideEffectJobHandlers(),
    options: NovelSideEffectWorkerOptions = {},
  ) {
    this.workerId = options.workerId
      ?? process.env.NOVEL_SIDE_EFFECT_WORKER_ID?.trim()
      ?? `novel-side-effect-${os.hostname()}-${process.pid}`;
    this.leaseMs = resolveNumberEnv("NOVEL_SIDE_EFFECT_WORKER_LEASE_MS", options.leaseMs ?? 120_000);
    this.pollMs = resolveNumberEnv("NOVEL_SIDE_EFFECT_WORKER_POLL_MS", options.pollMs ?? 5_000);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.jobService.recoverExpiredRunningJobs().catch((error) => {
      console.warn("[novel-side-effect-worker] failed to recover expired jobs", error);
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.isTicking) {
      return;
    }
    this.isTicking = true;
    try {
      const job = await this.jobService.leaseNext({
        workerId: this.workerId,
        leaseMs: this.leaseMs,
      });
      if (!job) {
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const unregister = job.novelId ? registerTaskCancellation(`novel:${job.novelId}`, cancel) : undefined;
      // Model-backed synchronization retains one owner for the whole job.
      const heartbeat = ["character.v2DeferredEnrichment", "chapter.manualSync", "chapter.timelineFinalization"].includes(job.jobType) ? setInterval(() => {
        void this.jobService.renewLease(job, this.leaseMs).then(owned => {
          if (!owned) cancel();
        }).catch(cancel);
      }, Math.max(250, Math.floor(this.leaseMs / 3))) : undefined;
      heartbeat?.unref();
      try {
        const result = await withExecutionSignal(controller.signal, () => this.handlers.execute(job));
        if (controller.signal.aborted) return;
        if (result?.deferUntil) await this.jobService.deferJob(job, result.deferUntil);
        else await this.jobService.markSucceeded(job);
      } catch (error) {
        if (controller.signal.aborted || error instanceof NovelSideEffectLeaseLostError) return;
        const forceDead = error instanceof UnsupportedNovelSideEffectPayloadError;
        await this.jobService.markFailedOrDead(job, error, { forceDead }).catch(updateError => {
          if (!(updateError instanceof NovelSideEffectLeaseLostError)) throw updateError;
        });
      } finally {
        unregister?.();
        if (heartbeat) clearInterval(heartbeat);
      }
    } finally {
      this.isTicking = false;
    }
  }
}

export const novelSideEffectWorker = new NovelSideEffectWorker();

