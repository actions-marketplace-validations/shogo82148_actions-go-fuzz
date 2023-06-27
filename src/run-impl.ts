import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as http from "@actions/http-client";
import * as path from "path";
import fs from "fs/promises";

interface FuzzOptions {
  repository: string;
  githubToken: string;
  githubGraphqlUrl: string;
  packages: string;
  workingDirectory: string;
  fuzzRegexp: string;
  fuzzTime: string;
  fuzzMinimizeTime: string;
  headBranchPrefix: string;
}

interface FuzzResult {
  TODO: string;
}

export async function fuzz(options: FuzzOptions): Promise<FuzzResult> {
  const exitCode = await core.group("fuzzing", async () => {
    return await exec.exec(
      "go",
      [
        "test",
        `-fuzz=${options.fuzzRegexp}`,
        `-fuzztime=${options.fuzzTime}`,
        `-fuzzminimizetime=${options.fuzzMinimizeTime}`,
        options.packages,
      ],
      { cwd: options.workingDirectory, ignoreReturnCode: true }
    );
  });

  if (exitCode === 0) {
    core.info("no fuzzing error");
    return {
      TODO: "fill me!",
    };
  }

  core.info("fuzzing error occurred");
  await core.group("generate report", async () => {
    await generateReport(options);
  });

  return {
    TODO: "fill me!",
  };
}

async function generateReport(options: FuzzOptions): Promise<void> {
  // const cwd = { cwd: options.workingDirectory };
  const ignoreReturnCode = { cwd: options.workingDirectory, ignoreReturnCode: true };

  const corpus = await getNewCorpus(options);
  if (corpus == null) {
    return;
  }
  core.info(`new corpus found: ${corpus}`);

  const client = new http.HttpClient("shogo82148/actions-go-fuzz", [], {
    headers: {
      Authorization: `Bearer ${options.githubToken}`,
      "X-Github-Next-Global-ID": "1",
    },
  });
  const repositoryId = await getRepositoryId(client, options);
  core.debug(`repositoryId: ${repositoryId}`);

  // create a new branch
  const packageName = await getPackageName(options);
  const segments = corpus.split(path.sep);
  const testFunc = segments[segments.length - 2];
  const testCorpus = segments[segments.length - 1];
  const branchName = `${options.headBranchPrefix}/${packageName}/${testFunc}/${testCorpus}`;
  const oid = await getHeadRef();
  await createBranch(client, options, repositoryId, branchName, oid);

  await exec.getExecOutput("go", ["test", `-run=${testFunc}/${testCorpus}`, options.packages], ignoreReturnCode);

  const ret = await fs.readFile(corpus);
  ret.toString("base64");

  // cleanup
  await exec.exec("git", ["restore", "--staged", "."], ignoreReturnCode);
  await fs.unlink(corpus);
}

async function getNewCorpus(options: FuzzOptions): Promise<string | undefined> {
  const cwd = { cwd: options.workingDirectory };
  const ignoreReturnCode = { cwd: options.workingDirectory, ignoreReturnCode: true };

  // check whether there is any changes.
  await exec.exec("git", ["add", "."], cwd);
  const hasChange = await exec.exec("git", ["diff", "--cached", "--exit-code", "--quiet"], ignoreReturnCode);
  if (hasChange === 0) {
    return undefined;
  }

  // find new test corpus.
  const output = await exec.getExecOutput(
    "git",
    ["diff", "--name-only", "--cached", "--no-renames", "--diff-filter=d"],
    cwd
  );
  const testdata = output.stdout.split("\n").filter((file) => {
    {
      const segments = file.split(path.sep);
      return (
        segments.length >= 4 &&
        segments[segments.length - 4] === "testdata" &&
        segments[segments.length - 3] === "fuzz" &&
        segments[segments.length - 2].startsWith("Fuzz")
      );
    }
  });
  if (testdata.length !== 1) {
    return undefined;
  }
  return testdata[0];
}

// getRepositoryId gets the repository id from GitHub GraphQL API.
async function getRepositoryId(client: http.HttpClient, options: FuzzOptions): Promise<string> {
  const [owner, name] = options.repository.split("/");
  const query = {
    query: `query ($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
      }
    }`,
    variables: {
      owner,
      name,
    },
  };

  interface Response {
    data: {
      repository: {
        id: string;
      };
    };
  }

  const response = await client.postJson<Response>(options.githubGraphqlUrl, query);
  if (response.result == null) {
    throw new Error("failed to get repository id");
  }
  return response.result.data.repository.id;
}

async function getHeadRef(): Promise<string> {
  const output = await exec.getExecOutput("git", ["rev-parse", "HEAD"]);
  return output.stdout.trim();
}

async function getPackageName(options: FuzzOptions): Promise<string> {
  const output = await exec.getExecOutput("go", ["list", options.packages], { cwd: options.workingDirectory });
  const pkg = output.stdout.trim();
  return pkg;
}

async function createBranch(
  client: http.HttpClient,
  options: FuzzOptions,
  repositoryId: string,
  name: string,
  oid: string
): Promise<void> {
  const query = {
    query: `mutation ($input: CreateRefInput!) {
      createRef(input: $input) {
        clientMutationId
      }
    }`,
    variables: {
      input: {
        repositoryId,
        name: `refs/heads/${name}`,
        oid,
      },
    },
  };
  core.info(JSON.stringify(query));

  const response = await client.postJson(options.githubGraphqlUrl, query);
  core.info(JSON.stringify(response));
}
