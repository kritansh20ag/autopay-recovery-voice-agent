import type { NextFunction, Request, Response } from "express";
import Retell from "retell-sdk";

export function retellSignatureGuard(apiKey: string | undefined, enforce: boolean) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (enforce) {
      const signature = req.header("x-retell-signature");
      const valid = !!apiKey && !!signature && (await Retell.verify(raw, apiKey, signature).catch(() => false));
      if (!valid) {
        res.status(401).json({ error: "invalid signature" });
        return;
      }
    }
    try {
      req.body = raw ? JSON.parse(raw) : {};
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    next();
  };
}
