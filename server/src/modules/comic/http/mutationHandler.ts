import type { RequestHandler } from "express";
import { withComicMutation } from "../../../services/comic/lifecycle";

export function comicMutationHandler(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await withComicMutation(async () => { await handler(req, res, next); });
    } catch (error) { next(error); }
  };
}
