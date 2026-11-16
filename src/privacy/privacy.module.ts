import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { QueueModule } from '../common/modules';
import { RedisService } from '../common/services/redis.service';
import { StorageModule } from '../storage/storage.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { PrivacyExportDownloadService } from './download/privacy-export-download.service';
import { PrivacyExportLinkSigner } from './download/privacy-export-link.signer';
import { PrivacyExportArchiveService } from './export/privacy-export-archive.service';
import { PrivacyExportCollectorService } from './export/privacy-export-collector.service';
import { PRIVACY_EXPORT_QUEUE } from './privacy-export.constants';
import { PrivacyExportController } from './privacy-export.controller';
import { PrivacyExportService } from './privacy-export.service';
import { PrivacyExportLifecycleService } from './queues/privacy-export-lifecycle.service';
import { PrivacyExportRecoveryService } from './queues/privacy-export-recovery.service';
import { PrivacyExportRetentionService } from './queues/privacy-export-retention.service';
import { PrivacyExportProcessor } from './queues/privacy-export.processor';
import { PrivacyExportQueueService } from './queues/privacy-export.queue';

@Module({
  imports: [
    QueueModule,
    StorageModule,
    // Read-only use of SubscriptionAccessService for the exported status.
    SubscriptionModule,
    BullModule.registerQueue({ name: PRIVACY_EXPORT_QUEUE }),
  ],
  controllers: [PrivacyExportController],
  providers: [
    PrivacyExportService,
    PrivacyExportQueueService,
    PrivacyExportProcessor,
    PrivacyExportRecoveryService,
    PrivacyExportRetentionService,
    PrivacyExportLifecycleService,
    PrivacyExportDownloadService,
    PrivacyExportLinkSigner,
    PrivacyExportCollectorService,
    PrivacyExportArchiveService,
    AuthGuard,
    RedisService,
  ],
})
export class PrivacyModule {}
