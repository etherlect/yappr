import pino from "pino";
import { recordWarn, recordError } from "./stats.js";

export const log = pino({
  // Count warns/errors into the ledger at the source, so the dashboard never has to
  // grep the log stream for them. pino levels: warn=40, error=50, fatal=60.
  hooks: {
    logMethod(args, method, level) {
      if (level >= 50) recordError();
      else if (level >= 40) recordWarn();
      return method.apply(this, args as Parameters<typeof method>);
    },
  },
  transport: {
    target: "pino-pretty",
    options: {
      translateTime: "yyyy-mm-dd HH:MM:ss",
      ignore: "pid,hostname",
      singleLine: true,
      colorize: true,
    },
  },
});
