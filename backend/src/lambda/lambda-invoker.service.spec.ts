/**
 * lambda-invoker.service.spec.ts
 *
 * Unit tests for LambdaInvokerService.
 * The AWS LambdaClient is mocked.
 */

import { ConfigService } from '@nestjs/config';
import { LambdaInvokerService } from './lambda-invoker.service.js';
import { InProcessSnapshotService } from './in-process-snapshot.service.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeCommand: jest.fn().mockImplementation((params: unknown) => params),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}));

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: jest.fn().mockImplementation((key: string) => overrides[key]),
  } as unknown as ConfigService;
}

function makeInProcessService(): jest.Mocked<InProcessSnapshotService> {
  return {
    computeBoard: jest.fn().mockResolvedValue(undefined),
    computeOrg: jest.fn().mockResolvedValue(undefined),
    computeAndPersist: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<InProcessSnapshotService>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LambdaInvokerService', () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  describe('when USE_LAMBDA=true and function name is set', () => {
    it('sends a RequestResponse invocation to the configured function', async () => {
      const config = makeConfig({
        USE_LAMBDA: 'true',
        DORA_SNAPSHOT_LAMBDA_NAME: 'fragile-dora-snapshot',
        AWS_REGION: 'ap-southeast-2',
      });
      const inProcess = makeInProcessService();
      const service = new LambdaInvokerService(config, inProcess);

      await service.invokeSnapshotWorker('ACC');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const [cmd] = mockSend.mock.calls[0] as [Record<string, unknown>];
      expect(cmd).toMatchObject({
        FunctionName: 'fragile-dora-snapshot',
        InvocationType: 'RequestResponse',
      });
      expect(inProcess.computeAndPersist).not.toHaveBeenCalled();
    });

    it('logs a warning but does not throw on LambdaClient error', async () => {
      const config = makeConfig({
        USE_LAMBDA: 'true',
        DORA_SNAPSHOT_LAMBDA_NAME: 'fragile-dora-snapshot',
      });
      mockSend.mockRejectedValueOnce(new Error('timeout'));
      const inProcess = makeInProcessService();
      const service = new LambdaInvokerService(config, inProcess);

      await expect(service.invokeSnapshotWorker('ACC')).resolves.toBeUndefined();
    });

    it('embeds the boardId in the invocation payload', async () => {
      const config = makeConfig({
        USE_LAMBDA: 'true',
        DORA_SNAPSHOT_LAMBDA_NAME: 'fn',
      });
      const inProcess = makeInProcessService();
      const service = new LambdaInvokerService(config, inProcess);

      await service.invokeSnapshotWorker('BPT');

      const [cmd] = mockSend.mock.calls[0] as [Record<string, unknown>];
      const payload = JSON.parse(
        Buffer.from(cmd['Payload'] as Buffer).toString(),
      ) as { boardId: string };
      expect(payload.boardId).toBe('BPT');
    });
  });

  describe('when USE_LAMBDA is not set (default local dev)', () => {
    it('delegates to InProcessSnapshotService.computeBoard for per-board invocation', async () => {
      const config = makeConfig({
        USE_LAMBDA: undefined,
        DORA_SNAPSHOT_LAMBDA_NAME: undefined,
      });
      const inProcess = makeInProcessService();
      const service = new LambdaInvokerService(config, inProcess);

      await service.invokeSnapshotWorker('ACC');

      expect(inProcess.computeBoard).toHaveBeenCalledWith('ACC');
      expect(inProcess.computeOrg).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('when USE_LAMBDA=false', () => {
    it('delegates to InProcessSnapshotService.computeBoard for per-board invocation', async () => {
      const config = makeConfig({
        USE_LAMBDA: 'false',
        DORA_SNAPSHOT_LAMBDA_NAME: 'fragile-dora-snapshot',
      });
      const inProcess = makeInProcessService();
      const service = new LambdaInvokerService(config, inProcess);

      await service.invokeSnapshotWorker('ACC');

      expect(inProcess.computeBoard).toHaveBeenCalledWith('ACC');
      expect(inProcess.computeOrg).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('delegates to InProcessSnapshotService.computeOrg for org invocation', async () => {
      const config = makeConfig({
        USE_LAMBDA: 'false',
        DORA_SNAPSHOT_LAMBDA_NAME: 'fragile-dora-snapshot',
      });
      const inProcess = makeInProcessService();
      const service = new LambdaInvokerService(config, inProcess);

      await service.invokeOrgSnapshot();

      expect(inProcess.computeOrg).toHaveBeenCalled();
      expect(inProcess.computeBoard).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('when USE_LAMBDA=true but function name is not set', () => {
    it('skips computation without calling InProcessSnapshotService', async () => {
      const config = makeConfig({
        USE_LAMBDA: 'true',
        DORA_SNAPSHOT_LAMBDA_NAME: undefined,
      });
      const inProcess = makeInProcessService();
      const service = new LambdaInvokerService(config, inProcess);

      await expect(service.invokeSnapshotWorker('ACC')).resolves.toBeUndefined();

      expect(inProcess.computeAndPersist).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
