import express from "express";
import cors from "cors";
import helmet from "helmet";
import { healthRouter } from "./routes/health.route";
import { demoRouter } from "./routes/demo.route";
import { companiesRouter } from "./modules/companies/companies.routes";
import { branchesRouter } from "./modules/branches/branches.routes";
import { catalogRouter } from "./modules/catalog/catalog.routes";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use(healthRouter);
app.use(demoRouter);
app.use(companiesRouter);
app.use(branchesRouter);
app.use(catalogRouter);

app.use((_req, res) => {
  res.status(404).json({
    error: "Not Found",
  });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);

  res.status(500).json({
    error: "Internal Server Error",
  });
});