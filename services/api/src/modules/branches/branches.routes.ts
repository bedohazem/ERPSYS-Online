import { Router } from "express";
import { db } from "../../db/pool";

export const branchesRouter = Router();

branchesRouter.get("/api/branches", async (req, res, next) => {
  try {
    const { companyId } = req.query;

    if (!companyId || typeof companyId !== "string") {
      return res.status(400).json({ error: "companyId query parameter is required" });
    }

    const result = await db.query(
      `
      SELECT id, company_id, code, name, address, phone, is_active, created_at, updated_at
      FROM branches
      WHERE company_id = $1
      ORDER BY created_at DESC;
      `,
      [companyId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

branchesRouter.post("/api/branches", async (req, res, next) => {
  try {
    const { companyId, code, name, address, phone } = req.body;

    if (!companyId || typeof companyId !== "string") {
      return res.status(400).json({ error: "companyId is required" });
    }

    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "Branch code is required" });
    }

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Branch name is required" });
    }

    const result = await db.query(
      `
      INSERT INTO branches (company_id, code, name, address, phone)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, company_id, code, name, address, phone, is_active, created_at, updated_at;
      `,
      [companyId, code.trim().toUpperCase(), name.trim(), address || null, phone || null]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
