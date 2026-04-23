/**
 * LambdaInvokerService
 *
 * Invokes the DORA snapshot Lambda function asynchronously after each board
 * sync. When USE_LAMBDA=false or DORA_SNAPSHOT_LAMBDA_NAME is not set, falls
 * back to InProcessSnapshotService (local development mode).
 *
 * Fire-and-forget: errors are logged but never rethrown — sync must not fail
 * because Lambda invocation fails.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from '@aws-sdk/client-lambda';
import { InProcessSnapshotService } from './in-process-snapshot.service.js';
import type { SnapshotHandlerEvent } from './snapshot.handler.js';

@Injectable()
export class LambdaInvokerService {
  private readonly logger = new Logger(LambdaInvokerService.name);
  private readonly client: LambdaClient | null;
  private readonly functionName: string | null;
  private readonly useLambda: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly inProcessSnapshot: InProcessSnapshotService,
  ) {
    this.useLambda = config.get<string>('USE_LAMBDA') !== 'false';
    this.functionName = config.get<string>('DORA_SNAPSHOT_LAMBDA_NAME') ?? null;

    if (this.useLambda && this.functionName) {
      this.client = new LambdaClient({
        region: config.get<string>('AWS_REGION') ?? 'ap-southeast-2',
      });
    } else {
      this.client = null;
      if (this.useLambda && !this.functionName) {
        this.logger.warn(
          'DORA_SNAPSHOT_LAMBDA_NAME is not set. ' +
          'Falling back to in-process snapshot computation.',
        );
      }
    }
  }

  async invokeSnapshotWorker(boardId: string): Promise<void> {
    // If not configured for Lambda, use the in-process fallback.
    if (!this.client || !this.functionName) {
      try {
        await this.inProcessSnapshot.computeAndPersist(boardId);
      } catch (err) {
        this.logger.warn(
          `In-process snapshot failed for board ${boardId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    const payload: SnapshotHandlerEvent = { boardId };

    try {
      await this.client.send(
        new InvokeCommand({
          FunctionName:   this.functionName,
          InvocationType: InvocationType.Event, // async fire-and-forget
          Payload:        Buffer.from(JSON.stringify(payload)),
        }),
      );
      this.logger.debug(`Invoked DORA snapshot Lambda for board: ${boardId}`);
    } catch (err) {
      // Invocation failure is non-fatal: sync has already succeeded.
      this.logger.warn(
        `Failed to invoke DORA snapshot Lambda for board ${boardId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
