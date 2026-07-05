import { app } from "./app";
import { env } from "./config/env";

app.listen(env.apiPort, () => {
  console.log(`ERPSYS API is running on http://localhost:${env.apiPort}`);
});
