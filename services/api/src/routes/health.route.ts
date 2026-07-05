import { Router } from "express";
import { db } from "../db/pool";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res, next) => {
  try {
    const result = await db.query("SELECT NOW() AS server_time");

    res.json({
      status: "ok",
      service: "erpsys-api",
      database: "connected",
      serverTime: result.rows[0].server_time,
    });
  } catch (error) {
    next(error);
  }
});
