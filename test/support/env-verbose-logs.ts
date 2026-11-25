/**
 * Imported right after a mode's environment file: the application logs at
 * every level, so a test can check everything it would ever write to a log.
 */
process.env.LOG_LEVEL = 'silly';
