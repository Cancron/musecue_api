import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { SubscriptionModule } from '../../subscription/subscription.module';
import { CreditAccountController } from './credit-account.controller';
import { CreditAccountService } from './credit-account.service';

/**
 * The signed-in user's credit balance and transaction history
 * (GET /v1/credits/balance, GET /v1/credits/transactions). The AI usage of
 * a makeup session is served by MakeupModule (GET
 * /v1/sessions/:sessionId/ai-usage).
 */
@Module({
  // SubscriptionModule: which credit sources the user may spend now.
  imports: [SubscriptionModule],
  controllers: [CreditAccountController],
  providers: [CreditAccountService, AuthGuard],
  // The daily rewards show the caller's balance.
  exports: [CreditAccountService],
})
export class CreditAccountModule {}
