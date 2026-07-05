import dotenv from "dotenv";

dotenv.config();

export const env = {
  apiPort: Number(process.env.API_PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "",
};

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is missing in .env");
}
