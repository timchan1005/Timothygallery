// Vercel serverless function: catch-all handler for /api/*.
//
// We instantiate the full Express app once per cold start and reuse it for
// subsequent invocations (Vercel keeps the function "warm" between requests).
// The Express app exposes every route defined in server/routes.ts unchanged,
// so the API surface is identical to local dev.

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes } from "../server/routes";

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

let appPromise: Promise<express.Express> | null = null;

function buildApp(): Promise<express.Express> {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    const app = express();

    app.use(
      express.json({
        limit: "10mb",
        verify: (req, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );
    app.use(express.urlencoded({ extended: false, limit: "10mb" }));

    // No HTTP server in a serverless context \u2014 pass null.
    await registerRoutes(null, app);

    // Generic error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      console.error("[api] error:", err);
      if (res.headersSent) return;
      res.status(status).json({ message });
    });

    return app;
  })();
  return appPromise;
}

// Vercel exports a default async handler. We bridge the Vercel (Node) req/res
// objects into the Express app.
export default async function handler(req: any, res: any) {
  try {
    const app = await buildApp();
    return app(req, res);
  } catch (err: any) {
    console.error("[api] top-level handler error:", err?.stack || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "handler_crash", message: String(err?.message || err), stack: String(err?.stack || "") }));
    }
  }
}
