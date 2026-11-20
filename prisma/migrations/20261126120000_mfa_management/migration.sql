-- MFA management: disabling MFA and replacing the authenticator need their
-- own step-up approvals. (Security notifications use "emailHistory" and the
-- audit trail "ActivityLogEvent"; no other schema change.)
ALTER TYPE "StepUpAction" ADD VALUE 'MFA_DISABLE';
ALTER TYPE "StepUpAction" ADD VALUE 'MFA_AUTHENTICATOR_REPLACE';
