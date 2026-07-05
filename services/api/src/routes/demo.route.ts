import { Router } from "express";
import { db } from "../db/pool";

export const demoRouter = Router();

demoRouter.get("/api/demo/companies", async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT id, name, is_active, created_at
      FROM companies
      ORDER BY created_at DESC
      LIMIT 10;
    `);

    res.json({
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
});
