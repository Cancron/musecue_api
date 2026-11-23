import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { CreditsModule } from '../../credits/credits.module';
import {
  LoyaltyMissionAdminController,
  LoyaltyMissionController,
} from './loyalty-mission.controllers';
import { LoyaltyMissionProgressService } from './loyalty-mission-progress.service';
import { LoyaltyMissionService } from './loyalty-mission.service';

/**
 * Loyalty missions: administrator-defined missions for verified makeup
 * completions (recorded by MakeupModule when a session is completed),
 * rewarded with MISSION_REWARD credits once per mission, user and period.
 */
@Module({
  imports: [CreditsModule],
  controllers: [LoyaltyMissionAdminController, LoyaltyMissionController],
  providers: [
    LoyaltyMissionService,
    LoyaltyMissionProgressService,
    ActivityLogService,
    AuthGuard,
    RolesGuard,
  ],
  exports: [LoyaltyMissionProgressService],
})
export class LoyaltyMissionsModule {}
