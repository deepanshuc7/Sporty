import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { commentary } from "../db/schema.js";
import { matchIdParamSchema } from "../validation/matches.js";
import {
  createCommentarySchema,
  listCommentaryQuerySchema,
} from "../validation/commentary.js";

export const commentaryRouter = Router({ mergeParams: true });

const MAX_LIMIT = 100;

function isForeignKeyViolation(error) {
  return error?.code === "23503" || error?.cause?.code === "23503";
}

commentaryRouter.get("/", async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: "Invalid match ID.",
      details: parsedParams.error.flatten(),
    });
  }

  const parsedQuery = listCommentaryQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({
      error: "Invalid query.",
      details: parsedQuery.error.flatten(),
    });
  }

  const limit = Math.min(parsedQuery.data.limit ?? MAX_LIMIT, MAX_LIMIT);

  try {
    const data = await db
      .select()
      .from(commentary)
      .where(eq(commentary.matchId, parsedParams.data.id))
      .orderBy(desc(commentary.createdAt))
      .limit(limit);

    return res.json({ data });
  } catch (error) {
    console.error("Failed to list commentary:", error);
    return res.status(500).json({ error: "Failed to list commentary." });
  }
});

commentaryRouter.post("/", async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: "Invalid match ID.",
      details: parsedParams.error.flatten(),
    });
  }

  const parsedBody = createCommentarySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Invalid payload.",
      details: parsedBody.error.flatten(),
    });
  }

  try {
    const [event] = await db
      .insert(commentary)
      .values({
        ...parsedBody.data,
        matchId: parsedParams.data.id,
      })
      .returning();

      if(res.app.locals.broadcastCommentary) {
        res.app.locals.broadcastCommentary(event.matchId, event);
      }

    return res.status(201).json({ data: event });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return res.status(404).json({ error: "Match not found." });
    }

    console.error("Failed to create commentary:", error);
    return res.status(500).json({ error: "Failed to create commentary." });
  }
});
