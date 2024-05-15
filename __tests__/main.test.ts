/* eslint-disable @typescript-eslint/no-explicit-any */

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as artifact from '@actions/artifact';
import * as path from 'path';
import { mocked } from 'jest-mock';
import { readFileSync, unlinkSync, promises } from 'fs';
import * as main from '../src/main';

// Unit tests for the action's main functionality, src/main.ts
const runMock = jest.spyOn(main, 'run');

jest.mock('@actions/artifact');
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: { access: jest.fn(), stat: jest.fn() },
    readFileSync: jest.fn(),
  };
});

// Mock the GitHub Actions libraries
let errorMock: jest.SpiedFunction<typeof core.error>;
let getInputMock: jest.SpiedFunction<typeof core.getInput>;
let setFailedMock: jest.SpiedFunction<typeof core.setFailed>;
let setOutputMock: jest.SpiedFunction<typeof core.setOutput>;

describe('action', () => {
  const mockUrl = 'https://www.website.com';

  describe('pollAssessmentForStatus', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    afterEach(async () => {
      jest.clearAllMocks();
    });

    it('should throw an error if the assessment goes into a failed state', async () => {
      const execSpy = jest.spyOn(exec, 'exec');
      execSpy
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'testing' })));
          return 0;
        })
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'failed' })));
          return 0;
        });

      await expect(main.pollAssessmentForStatus('mockAssessmentId', 'mockInstanceId', 'complete')).rejects.toThrow(
        'MATRIX automated test failed!',
      );
      expect(execSpy.mock.calls.length).toBe(2);
    });

    it('should keep polling until desired state has been reached', async () => {
      const execSpy = jest.spyOn(exec, 'exec');
      execSpy
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'testing' })));
          return 0;
        })
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'testing' })));
          return 0;
        })
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'readyForTesting' })));
          return 0;
        });

      const resp = await main.pollAssessmentForStatus('mockAssessmentId', 'mockInstanceId', 'readyForTesting');
      expect(resp).toEqual('readyForTesting');
      expect(execSpy.mock.calls.length).toBe(3);
    }, 10000);
  });

  describe('getFilePathTypes', () => {
    beforeEach(() => {
      jest.resetModules();

      getInputMock = jest.spyOn(core, 'getInput');
    });

    afterEach(async () => {
      jest.clearAllMocks();
    });

    it('should throw an error if a file path is neither a URL or relative path', async () => {
      getInputMock.mockImplementation(() => 'invalid');
      (promises.stat as jest.Mock).mockImplementation(async () => Promise.resolve(false));

      try {
        await main.getFilePathTypes();
      } catch (err: any) {
        expect(err.message).toEqual('Provided file path is invalid: appPath');
      }
    });

    it('should add initial forward slash if missing', async () => {
      getInputMock.mockImplementation(() => 'test/filePath').mockImplementationOnce(() => mockUrl);

      (promises.stat as jest.Mock).mockImplementation(async () => Promise.resolve(true));

      const resp = await main.getFilePathTypes();
      expect(resp).toEqual({ appPath: 'url', userActions: 'relative', keywords: 'relative' });
    });

    it('should return dict of file path types', async () => {
      getInputMock.mockImplementation(() => '/test/filePath').mockImplementationOnce(() => mockUrl);

      (promises.stat as jest.Mock).mockImplementation(async () => Promise.resolve(true));

      const resp = await main.getFilePathTypes();
      expect(resp).toEqual({ appPath: 'url', userActions: 'relative', keywords: 'relative' });
    });
  });

  describe('run', () => {
    const validateExecCall = async (actual: string, expected: string): Promise<void> => {
      expect(actual).toEqual(expect.stringContaining(expected));
    };

    beforeEach(() => {
      jest.resetModules();

      errorMock = jest.spyOn(core, 'error').mockImplementation();
      getInputMock = jest.spyOn(core, 'getInput').mockImplementation();
      setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation();
      setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation();
      mocked(readFileSync).mockReturnValueOnce(JSON.stringify([{ wait: 100 }, { duration: 400 }]));
      process.env.PROJECT = 'mockProjectId';
      process.env.API_TOKEN = 'mockApiToken';
      process.env.GITHUB_WORKSPACE = path.join(__dirname, '.');
    });

    afterEach(async () => {
      jest.clearAllMocks();
    });

    it(`should throw an error if 'PROJECT' secret is missing`, async () => {
      delete process.env.PROJECT;

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Environment secret missing: PROJECT');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'API_TOKEN' secret is missing`, async () => {
      delete process.env.API_TOKEN;

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Environment secret missing: API_TOKEN');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'deviceFlavor' input is missing`, async () => {
      getInputMock.mockImplementation(name => (name === 'deviceFlavor' ? '' : 'mockVal'));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Input required and not supplied: deviceFlavor');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'deviceOS' input is missing`, async () => {
      getInputMock.mockImplementation(name => (name === 'deviceOS' ? '' : 'mockVal'));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Input required and not supplied: deviceOS');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'appPath' input is missing`, async () => {
      getInputMock.mockImplementation(name => (name === 'appPath' ? '' : 'mockVal'));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Input required and not supplied: appPath');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'appPath' input is invalid`, async () => {
      getInputMock.mockImplementation(name => (name === 'appPath' ? 'invalid' : mockUrl));
      (promises.stat as jest.Mock).mockImplementation(async () => Promise.resolve(false));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Provided file path is invalid: appPath');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'userActions' input is missing`, async () => {
      getInputMock.mockImplementation(name => (name === 'userActions' ? '' : 'mockVal'));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Input required and not supplied: userActions');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'userActions' input is invalid`, async () => {
      getInputMock.mockImplementation(name => (name === 'userActions' ? 'notValid' : mockUrl));
      (promises.stat as jest.Mock).mockImplementation(async () => Promise.resolve(false));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Provided file path is invalid: userActions');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it(`should throw an error if 'keywords' exists and is invalid`, async () => {
      getInputMock.mockImplementation(name => (name === 'keywords' ? 'invalid' : mockUrl));
      (promises.stat as jest.Mock).mockImplementation(async () => Promise.resolve(false));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(setFailedMock).toHaveBeenCalledWith('Provided file path is invalid: keywords');
      expect(errorMock).not.toHaveBeenCalled();
    });

    it('should execute MATRIX', async () => {
      const workspaceDir = process.env.GITHUB_WORKSPACE as string;
      const reportArtifactPath = 'mockDownloadPath';
      const instanceId = 'mockInstanceId';
      const bundleId = 'com.android.egg';
      const wordlistId = 'wordlistId';
      getInputMock.mockImplementation(input => {
        if (input === 'appPath') {
          return mockUrl;
        }
        if (input === 'userActions') {
          return '/test/user-actions.json';
        }
        if (input === 'keywords') {
          return 'test/keywords.txt';
        }
        return 'mockVal';
      });
      (promises.stat as jest.Mock).mockImplementation(async () => Promise.resolve(true));

      const execSpy = jest.spyOn(exec, 'exec');
      execSpy
        // install corellium-cli
        .mockImplementationOnce(async () => Promise.resolve(0))
        // log into cli
        .mockImplementationOnce(async () => Promise.resolve(0))
        // create instance
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(instanceId));
          return 0;
        })
        // download app
        .mockImplementationOnce(async () => Promise.resolve(0))
        // install app
        .mockImplementationOnce(async () => Promise.resolve(0))
        // getBundleId
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify([{ applicationType: 'User', bundleID: bundleId }])));
          return 0;
        })
        // uploadWordlistFile
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify([{ id: wordlistId }])));
          return 0;
        })
        // running MATRIX
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ id: 'mockAssessmentId' })));
          return 0;
        })
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'new' })));
          return 0;
        })
        .mockImplementationOnce(async () => Promise.resolve(0))
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'monitoring' })));
          return 0;
        })
        .mockImplementationOnce(async () => Promise.resolve(0))
        .mockImplementationOnce(async () => Promise.resolve(0))
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'readyForTesting' })));
          return 0;
        })
        .mockImplementationOnce(async () => Promise.resolve(0))
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from(JSON.stringify({ status: 'complete' })));
          return 0;
        })
        .mockImplementationOnce(async (_command, _args, options: any) => {
          options.listeners.stdout(Buffer.from('mastReport'));
          return 0;
        })
        // cleanup
        .mockImplementationOnce(async () => Promise.resolve(0))
        .mockImplementationOnce(async () => Promise.resolve(0))
        .mockImplementationOnce(async () => Promise.resolve(0));

      jest.spyOn(artifact, 'DefaultArtifactClient').mockImplementation();
      const uploadArtifactMock = jest
        .spyOn(artifact.DefaultArtifactClient.prototype, 'uploadArtifact')
        .mockImplementation(async () => Promise.resolve({ id: 1234 }));
      const downloadArtifactMock = jest
        .spyOn(artifact.DefaultArtifactClient.prototype, 'downloadArtifact')
        .mockImplementation(async () => Promise.resolve({ downloadPath: reportArtifactPath }));

      await main.run();
      expect(runMock).toHaveReturned();
      expect(uploadArtifactMock).toHaveBeenCalled();
      expect(downloadArtifactMock).toHaveBeenCalled();
      expect(setOutputMock).toHaveBeenNthCalledWith(1, 'report', expect.stringMatching(reportArtifactPath));

      validateExecCall(execSpy.mock.calls[0][0], 'npm install -g @corellium/corellium-cli');
      validateExecCall(execSpy.mock.calls[1][0], 'corellium login --endpoint');
      validateExecCall(execSpy.mock.calls[2][0], 'corellium instance create');
      validateExecCall(execSpy.mock.calls[3][0], `curl -L -o ${path.join(workspaceDir, 'appFile')} ${mockUrl}`);
      validateExecCall(execSpy.mock.calls[4][0], 'corellium apps install --project');
      validateExecCall(execSpy.mock.calls[5][0], 'corellium apps --project');
      validateExecCall(execSpy.mock.calls[6][0], 'corellium image create --project');
      validateExecCall(
        execSpy.mock.calls[7][0],
        `corellium matrix create-assessment --instance ${instanceId} --bundle ${bundleId} --wordlist ${wordlistId}`,
      );
      validateExecCall(execSpy.mock.calls[8][0], `corellium matrix get-assessment --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[9][0], `corellium matrix start-monitor --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[10][0], `corellium matrix get-assessment --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[11][0], `corellium input ${instanceId}`);
      validateExecCall(execSpy.mock.calls[12][0], `corellium matrix stop-monitor --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[13][0], `corellium matrix get-assessment --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[14][0], `corellium matrix test --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[15][0], `corellium matrix get-assessment --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[16][0], `corellium matrix download-report --instance ${instanceId}`);
      validateExecCall(execSpy.mock.calls[17][0], `corellium instance stop ${instanceId}`);
      validateExecCall(execSpy.mock.calls[18][0], `corellium instance delete ${instanceId}`);
      validateExecCall(execSpy.mock.calls[19][0], 'corellium logout');

      unlinkSync(path.join(__dirname, './report.html'));
    }, 15000);
  });
});
