/**
 * LambdaInvokerService
 *
 * Invokes the DORA snapshot Lambda function synchronously (RequestResponse)
 * after each board sync so that errors surface in App Runner logs and the
 * org-level snapshot is guaranteed to run only after all per-board rows are
 * written to the database.
 *
 * When USE_LAMBDA=false or DORA_SNAPSHOT_LAMBDA_NAME is not set, falls back
 * to InProcessSnapshotService (local development mode).
 *
 * Errors are logged but never rethrown — sync must not fail because Lambda
 * invocation fails.
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
    this.useLambda = config.get<string>('USE_LAMBDA') === 'true';
    this.functionName = config.get<string>('DORA_SNAPSHOT_LAMBDA_NAME') ?? null;

    if (this.useLambda && this.functionName) {
      this.client = new LambdaClient({
        region: config.get<string>('AWS_REGION') ?? 'ap-southeast-2',
      });
    } else {
      this.client = null;
      if (this.useLambda && !this.functionName) {
        this.logger.warn(
          'USE_LAMBDA=true but DORA_SNAPSHOT_LAMBDA_NAME is not set. ' +
          'Snapshot computation will be skipped to avoid in-process OOM risk.',
        );
      }
    }
  }

  async invokeSnapshotWorker(boardId: string): Promise<void> {
    await this.invoke({ boardId }, `board ${boardId}`);
  }

  /**
   * Invoke the Lambda (or in-process fallback) to compute the org-level
   * (__org__) snapshot. Must be called once after ALL per-board invocations
   * complete so that the per-board snapshot rows are present in the DB for
   * the org handler to read and merge.
   */
  async invokeOrgSnapshot(): Promise<void> {
    await this.invoke({ boardId: '__org__', orgSnapshot: true }, 'org-level');
  }

  private async invoke(payload: SnapshotHandlerEvent, label: string): Promise<void> {
    // USE_LAMBDA=true but no function name: skip to avoid OOM risk
    if (this.useLambda && !this.functionName) {
      this.logger.warn(
        `Skipping DORA snapshot for ${label}: ` +
        `USE_LAMBDA=true but DORA_SNAPSHOT_LAMBDA_NAME is not configured.`,
      );
      return;
    }

    // USE_LAMBDA=false: in-process fallback is intentional
    if (!this.client || !this.functionName) {
      try {
        if (payload.orgSnapshot) {
          await this.inProcessSnapshot.computeOrg();
        } else {
          await this.inProcessSnapshot.computeBoard(payload.boardId);
        }
      } catch (err) {
        this.logger.warn(
          `In-process snapshot failed for ${label}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // Lambda invocation path — synchronous (RequestResponse) so that:
    //   1. Errors are surfaced in App Runner logs immediately.
    //   2. Per-board rows are guaranteed to be written before invokeOrgSnapshot
    //      is called (sync.service.ts awaits each invokeSnapshotWorker serially).
    try {
      const response = await this.client.send(
        new InvokeCommand({
          FunctionName:   this.functionName,
          InvocationType: InvocationType.RequestResponse,
          Payload:        Buffer.from(JSON.stringify(payload)),
        }),
      );

      // FunctionError is set when the Lambda handler threw (e.g. unhandled exception).
      if (response.FunctionError) {
        const body = response.Payload
          ? Buffer.from(response.Payload).toString('utf-8')
          : '(no payload)';
        this.logger.error(
          `DORA snapshot Lambda error for ${label}: ${response.FunctionError} — ${body}`,
        );
      } else {
        this.logger.debug(`DORA snapshot Lambda completed for ${label}`);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to invoke DORA snapshot Lambda for ${label}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
