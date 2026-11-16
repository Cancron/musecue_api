/** The export cannot succeed on retry (for example, the account is gone). */
export class PrivacyExportPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyExportPermanentError';
  }
}

/** Another worker attempt claimed the export; this attempt must stop quietly. */
export class PrivacyExportSupersededError extends Error {
  constructor() {
    super('The export attempt was superseded');
    this.name = 'PrivacyExportSupersededError';
  }
}
