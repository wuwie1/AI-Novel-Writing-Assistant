import { Router } from "express";
import { z } from "zod";
import type { LlmLiveStreamFrame } from "@ai-novel/shared/types/llmLive";
import { validate } from "../../../../middleware/validate";
import { llmLiveBroker, type LlmLiveBroker } from "../LlmLiveBroker";
import { isObservationDraining } from "./observationDrain";

const streamQuerySchema = z.object({
  taskId: z.string().trim().min(1).optional(),
  interactionId: z.string().trim().min(1).optional(),
});

function writeFrame(res: import("express").Response, frame: LlmLiveStreamFrame, eventId?: number): void {
  if (res.writableEnded) {
    return;
  }
  if (eventId != null) {
    res.write("id: " + eventId + "\n");
  }
  res.write("event: llm_live\n");
  res.write("data: " + JSON.stringify(frame) + "\n\n");
}

export function createLlmLiveRouter({
  broker = llmLiveBroker,
  drainActive = isObservationDraining,
  drainPollMs = 1_000,
}: {
  broker?: LlmLiveBroker;
  drainActive?: () => Promise<boolean>;
  drainPollMs?: number;
} = {}) {
  const router = Router();
  router.get("/stream", validate({ query: streamQuerySchema }), async (req, res, next) => {
    try {
      if (await drainActive()) {
        res.setHeader("Retry-After", "2");
        res.setHeader("Connection", "close");
        res.status(503).json({ success: false, error: "服务维护中，实况连接将自动恢复。" });
        return;
      }
      if (res.destroyed) return;
      const filter = streamQuerySchema.parse(req.query);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      // End the upstream socket along with this response; SSE does not need HTTP socket reuse.
      res.setHeader("Connection", "close");
      res.flushHeaders?.();
      writeFrame(res, { type: "snapshot", sessions: broker.getSnapshots(filter) });
      const unsubscribe = broker.subscribe(filter, event => {
        writeFrame(res, { type: "event", event }, event.seq);
      });
      let closed = false;
      let checkingDrain = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(drainTimer);
        unsubscribe();
      };
      const finishObservation = () => { cleanup(); res.end(); };
      const heartbeat = setInterval(() => writeFrame(res, { type: "ping" }), 15_000);
      const drainTimer = setInterval(async () => {
        if (closed || checkingDrain) return;
        checkingDrain = true;
        try { if (await drainActive() && !closed) finishObservation(); }
        catch { if (!closed) finishObservation(); }
        finally { checkingDrain = false; }
      }, drainPollMs);
      heartbeat.unref();
      drainTimer.unref();
      res.once("close", cleanup);
      req.once("close", cleanup);
    } catch (error) { next(error); }
  });
  return router;
}

export default createLlmLiveRouter();
