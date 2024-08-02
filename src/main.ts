import * as core from '@actions/core';
import { exec } from '@actions/exec';
import { DefaultArtifactClient } from '@actions/artifact';
import * as path from 'path';
import fs from 'fs';

enum PathType {
  URL = 'url',
  RELATIVE = 'relative',
}
type FilePathTypes = Record<string, PathType>;

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    validateInputsAndEnv();
    const pathTypes = await getFilePathTypes();
    await installCorelliumCli();
    
    let instanceId = core.getInput('instanceId').trim(); // Ensure we trim the input
    const reportFormat = core.getInput('reportFormat');
    let finalInstanceId: string;
    let bundleId: string;
    let isNewInstance = false;

    // Log the trimmed instanceId
    core.info(`Received trimmed instanceId: '${instanceId}'`); // Use single quotes to detect empty spaces
    core.info(`Received reportFormat: ${reportFormat}`);

    // Check if instanceId is provided and not empty
    if (instanceId && instanceId.length > 0) {
      finalInstanceId = instanceId;
      core.info(`Using existing instance with instanceId: ${finalInstanceId}`);
    } else {
      const setupResult = await setupDevice();
      finalInstanceId = setupResult.instanceId;
      isNewInstance = true;
      core.info(`New device created with instanceId: ${finalInstanceId}`);
    }

    bundleId = await setupApp(finalInstanceId, pathTypes);
    const report = await runMatrix(finalInstanceId, bundleId, pathTypes);
    
    if (isNewInstance) {
      core.info(`Cleaning up new instance: ${finalInstanceId}`);
      await cleanup(finalInstanceId);
    }
    
    await storeReportInArtifacts(report, bundleId, reportFormat);
  } catch (error) {
    core.error(`Error in run: ${error.message}`);
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

async function installCorelliumCli(): Promise<void> {
  core.info('Installing Corellium-CLI...');
  await exec('npm install -g @corellium/corellium-cli@1.3.2');
  await execCmd(`corellium login --endpoint ${core.getInput('server')} --apitoken ${process.env.API_TOKEN}`);
}

async function setupApp(instanceId: string, pathTypes: FilePathTypes): Promise<string> {
  const projectId = process.env.PROJECT;

  core.info('Downloading app...');
  const appPath = await downloadFile('appFile', core.getInput('appPath'), pathTypes.appPath);

  core.info(`Installing app on ${instanceId}...`);
  await execCmd(`corellium apps install --project ${projectId} --instance ${instanceId} --app ${appPath}`);

  const instanceStr = await execCmd(`corellium instance get --instance ${instanceId}`);
  const instance = tryJsonParse(instanceStr) as unknown as { type: string };
  if (instance?.type === 'ios') {
    core.info('Unlocking device...');
    await execCmd(`corellium instance unlock --instance ${instanceId}`);
  }

  const bundleId = await getBundleId(instanceId);

  core.info(`Opening ${bundleId} on ${instanceId}...`);
  await execCmd(`corellium apps open --project ${projectId} --instance ${instanceId} --bundle ${bundleId}`);

  return bundleId;
}

async function setupDevice(): Promise<{ instanceId: string }> {
  const projectId = process.env.PROJECT;

  core.info('Creating device...');
  const resp = await execCmd(
    `corellium instance create ${core.getInput('deviceFlavor')} ${core.getInput('deviceOS')} ${projectId} --wait`,
  );
  const instanceId = resp?.toString().trim();
  return { instanceId };
}

async function runMatrix(instanceId: string, bundleId: string, pathTypes: FilePathTypes): Promise<string> {
  const [wordlistId, inputInfo] = await Promise.all([
    uploadWordlistFile(instanceId, pathTypes.keywords),
    downloadInputFile(pathTypes.userActions),
  ]);
  const inputsFilePath = inputInfo.inputsFilePath;
  const inputsTimeout = inputInfo.inputsTimeout;

  core.info('Running MATRIX...');

  core.info('Creating assessment...');
  let assessmentId: string | undefined;
  try {
    let createAssessment = `corellium matrix create-assessment --instance ${instanceId} --bundle ${bundleId}`;
    if (wordlistId) {
      createAssessment += ` --wordlist ${wordlistId}`;
    }
    const resp = await execCmd(createAssessment);
    assessmentId = (tryJsonParse(resp) as { id: string })?.id;
    core.info(`Created assessment ${assessmentId}...`);
  } catch (err) {
    throw new Error(`Error creating MATRIX assessment! err=${err}`);
  }

  await pollAssessmentForStatus(assessmentId, instanceId, 'new');
  core.info('Starting monitor...');
  await execCmd(`corellium matrix start-monitor --instance ${instanceId} --assessment ${assessmentId}`);

  await pollAssessmentForStatus(assessmentId, instanceId, 'monitoring');
  core.info('Executing inputs on device...');
  await execCmd(`corellium input ${instanceId} ${inputsFilePath}`);
  core.info(`Waiting ${inputsTimeout}ms for inputs to execute...`);
  await wait(inputsTimeout);

  core.info('Stopping monitor...');
  await execCmd(`corellium matrix stop-monitor --instance ${instanceId} --assessment ${assessmentId}`);

  await pollAssessmentForStatus(assessmentId, instanceId, 'readyForTesting');
  core.info('Executing tests...');
  await execCmd(`corellium matrix test --instance ${instanceId} --assessment ${assessmentId}`);

  await pollAssessmentForStatus(assessmentId, instanceId, 'complete');
  core.info('Downloading assessment...');
  return await execCmd(`corellium matrix download-report --instance ${instanceId} --assessment ${assessmentId}`);
}

async function cleanup(instanceId: string): Promise<void> {
  core.info('Cleaning up...');
  await execCmd(`corellium instance stop ${instanceId}`);
  await execCmd(`corellium instance delete ${instanceId}`);
  await execCmd(`corellium logout`);
}

async function getBundleId(instanceId: string): Promise<string> {
  const resp = await execCmd(`corellium apps --project ${process.env.PROJECT} --instance ${instanceId}`);
  const appList = tryJsonParse(resp) as unknown as { applicationType: string; bundleID: string }[];
  const bundleId = appList?.find(app => app.applicationType === 'User')?.bundleID;
  if (!bundleId) {
    throw new Error('Error getting bundleId!');
  }
  return bundleId;
}

async function uploadWordlistFile(instanceId: string, pathType: PathType): Promise<string | undefined> {
  const keywords = core.getInput('keywords');
  if (!keywords) {
    return;
  }

  core.info('Uploading wordlist...');
  const wordlistPath = await downloadFile('wordlist.txt', keywords, pathType);
  const resp = await execCmd(
    `corellium image create --project ${process.env.PROJECT} --instance ${instanceId} --format json wordlist.txt mast-wordlist plain ${wordlistPath}`,
  );
  const uploadedWordlistResp = tryJsonParse(resp) as unknown as { id: string }[];
  const wordlistId = uploadedWordlistResp?.[0].id;
  core.info(`Uploaded wordlist: ${wordlistId}`);
  return wordlistId;
}

async function downloadInputFile(pathType: PathType): Promise<{ inputsFilePath: string; inputsTimeout: number }> {
  const inputsFilePath = await downloadFile('inputs.json', core.getInput('userActions'), pathType);

  // estimating time it takes to execute device inputs - has 10s buffer
  const inputsJson = JSON.parse(fs.readFileSync(inputsFilePath, 'utf-8'));
  const inputsTimeout = inputsJson.reduce((acc: number, curr: { wait?: number; duration?: number }) => {
    if (curr.wait) {
      acc += curr.wait;
    }
    if (curr.duration) {
      acc += curr.duration;
    }
    return acc;
  }, 10000);

  return { inputsFilePath, inputsTimeout };
}

export async function pollAssessmentForStatus(
  assessmentId: string,
  instanceId: string,
  expectedStatus: string,
): Promise<string> {
  const getAssessmentStatus = async (): Promise<string> => {
    const resp = await execCmd(`corellium matrix get-assessment --instance ${instanceId} --assessment ${assessmentId}`);
    return (tryJsonParse(resp) as { status: string })?.status;
  };

  let actualStatus = await getAssessmentStatus();
  while (actualStatus !== expectedStatus) {
    await wait();
    actualStatus = await getAssessmentStatus();
    if (actualStatus === 'failed') {
      throw new Error('MATRIX automated test failed!');
    }
  }

  return actualStatus;
}

async function storeReportInArtifacts(report: string, bundleId: string, reportFormat: string): Promise<void> {
  const workspaceDir = process.env.GITHUB_WORKSPACE as string;
  const reportPath = path.join(workspaceDir, `report.${reportFormat}`);
  fs.writeFileSync(reportPath, report);
  const flavor = core.getInput('deviceFlavor');

  const artifact = new DefaultArtifactClient();

  const { id } = await artifact.uploadArtifact(`matrix-report-${flavor}-${bundleId}`, [reportPath], workspaceDir);
  if (!id) {
    throw new Error('Failed to upload MATRIX report artifact!');
  }

  const { downloadPath } = await artifact.downloadArtifact(id);

  core.setOutput('report', downloadPath);
}

function validateInputsAndEnv(): void {
  if (!process.env.API_TOKEN) {
    throw new Error('Environment secret missing: API_TOKEN');
  }
  if (!process.env.PROJECT) {
    throw new Error('Environment secret missing: PROJECT');
  }

  // inputs from action file are not validated https://github.com/actions/runner/issues/1070
  const requiredInputs = ['deviceFlavor', 'deviceOS', 'appPath', 'userActions', 'reportFormat'];
  requiredInputs.forEach((input: string) => {
    const inputResp = core.getInput(input);
    if (!inputResp || typeof inputResp !== 'string' || inputResp === '') {
      throw new Error(`Input required and not supplied: ${input}`);
    }
  });
}

async function downloadFile(fileNameToSave: string, pathValue: string, pathType: PathType): Promise<string> {
  const workspaceDir = process.env.GITHUB_WORKSPACE as string;
  const downloadPath = path.join(workspaceDir, fileNameToSave);

  // download file from URL, otherwise already on github workspace
  if (pathType === PathType.URL) {
    await exec(`curl -L -o ${downloadPath} ${pathValue}`, [], { silent: true });
    return downloadPath;
  } else {
    return `${workspaceDir}${pathValue.startsWith('/') ? pathValue : `/${pathValue}`}`;
  }
}

async function wait(ms = 3000): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function execCmd(cmd: string): Promise<string> {
  let err = '';
  let resp = '';

  await exec(cmd, [], {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        resp += data;
      },
      stderr: (data: Buffer) => {
        err += data.toString();
      },
    },
  });
  if (err) {
    throw new Error(`Error occurred executing ${cmd}! err=${err}`);
  }
  return resp;
}

export async function getFilePathTypes(): Promise<FilePathTypes> {
  // these can be either URLs or file relative to the github workspace
  const pathInputs = ['appPath', 'userActions', 'keywords'];

  const workspaceDir = process.env.GITHUB_WORKSPACE as string;

  const pathInputsWithTypes: FilePathTypes = {};
  for (const pathInput of pathInputs) {
    const filePath = core.getInput(pathInput);
    if (filePath) {
      try {
        new URL(filePath);
        pathInputsWithTypes[pathInput] = PathType.URL;
        continue;
      } catch (_) {
        if (
          !!(await fs.promises
            .stat(`${workspaceDir}${filePath.startsWith('/') ? filePath : `/${filePath}`}`)
            .catch(() => false))
        ) {
          pathInputsWithTypes[pathInput] = PathType.RELATIVE;
          continue;
        }

        throw new Error(`Provided file path is invalid: ${pathInput}`);
      }
    }
  }
  return pathInputsWithTypes;
}

function tryJsonParse(jsonStr: string): Record<string, unknown> | undefined {
  let obj = undefined;

  if (jsonStr && typeof jsonStr === 'string' && jsonStr !== '') {
    try {
      obj = JSON.parse(jsonStr);
    } catch (err) {
      // do nothing
    }
  }

  return obj;
}
