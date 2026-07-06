import { Router } from "express";
import { db } from "../../db/pool";

export const companiesRouter = Router();

companiesRouter.get("/api/companies", async (_req, res, next) => {
  try {
    const result = await db.query(`
      SELECT id, name, legal_name, tax_number, is_active, created_at, updated_at
      FROM companies
      ORDER BY created_at DESC;
    `);

    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

companiesRouter.post("/api/companies", async (req, res, next) => {
  try {
    const { name, legalName, taxNumber } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Company name is required" });
    }

    const result = await db.query(
      `
      INSERT INTO companies (name, legal_name, tax_number)
      VALUES ($1, $2, $3)
      RETURNING id, name, legal_name, tax_number, is_active, created_at, updated_at;
      `,
      [name.trim(), legalName || null, taxNumber || null]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
